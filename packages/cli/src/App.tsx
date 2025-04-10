import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import {
  LoomEngine,
  type NodeId,
  type NodeData,
  type Message,
  type RootData
} from '@ankhdt/loom-engine';
import {
  handleCommand,
  isCommand,
  UNREAD_TAG,
  type Command
} from './commands.ts';
import { render } from 'ink';
import { formatError } from './util.ts';
import fs from 'fs/promises';
import path from 'path';

// --- Interfaces ---

interface LoomAppProps {
  engine: LoomEngine;
  initialNodeId: NodeId;
  options: {
    dataDir: string;
    n: number;
    temperature: number;
    maxTokens: number;
    debug: boolean;
  };
  onExit: () => void; // Function to call for graceful exit
}

interface DisplayMessage extends Message {
  nodeId: NodeId; // Keep track of the source node for potential future use
  isChildPreview?: boolean;
}

// --- Main Component ---

export async function start(props: LoomAppProps) {
  const instance = render(<LoomApp {...props} />);
  await instance.waitUntilExit();
}

export function LoomApp({
  engine,
  initialNodeId,
  options,
  onExit
}: LoomAppProps) {
  useApp();
  const [currentNodeId, setCurrentNodeId] = useState<NodeId>(initialNodeId);
  const [history, setHistory] = useState<DisplayMessage[]>([]);
  const [children, setChildren] = useState<NodeData[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<NodeId[]>([]);
  const [root, setRoot] = useState<RootData | null>(null);

  // State for focus management
  const [focusedElement, setFocusedElement] = useState<'input' | 'children'>(
    'input'
  );
  const [selectedChildIndex, setSelectedChildIndex] = useState<number>(0);

  // --- Data Fetching Effect ---
  useEffect(() => {
    const fetchData = async () => {
      engine.log(`Current node: ${currentNodeId}`);
      setIsLoading(true);
      setError(null);
      try {
        // Set current node ID
        await fs.writeFile(
          path.join(options.dataDir, 'current-node-id'),
          currentNodeId,
          'utf-8'
        );

        // Fetch history
        const nodeHistory = await engine
          .getForest()
          .getPath({ from: undefined, to: currentNodeId });

        const displayMessages: DisplayMessage[] = nodeHistory.path.map(
          node => ({
            ...node.message,
            nodeId: node.id
          })
        );

        setRoot(nodeHistory.root);
        setHistory(displayMessages);

        // Fetch children
        const fetchedChildren = await engine
          .getForest()
          .getChildren(currentNodeId);
        setChildren(fetchedChildren);

        const node = await engine.getForest().getNode(currentNodeId);
        const parentNode = node?.parent_id
          ? await engine.getForest().getNode(node.parent_id)
          : null;
        setSiblings(parentNode?.child_ids || [currentNodeId]);

        // Clear the unread tag
        if (node?.parent_id) {
          await engine.getForest().updateNodeMetadata(node.id, {
            ...node.metadata,
            tags: node.metadata.tags?.filter(tag => tag !== UNREAD_TAG)
          });
        }

        setSelectedChildIndex(0); // Reset selection when node changes
      } catch (err) {
        setError(formatError(err, options.debug));
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [engine, currentNodeId, options.debug, options.dataDir]);

  // --- Input Handling ---
  const handleCommandAndUpdate = async (command: Command, args: string[]) => {
    setIsLoading(true);
    setError(null);
    let nextNodeId = currentNodeId;

    try {
      if (command === 'exit') {
        onExit(); // Call the passed exit handler
        return;
      } else {
        nextNodeId = await handleCommand(
          command,
          args,
          engine,
          currentNodeId,
          options
        );
      }

      setIsLoading(false);
      if (nextNodeId !== currentNodeId) {
        setCurrentNodeId(nextNodeId);
      }
    } catch (err) {
      setError(formatError(err, options.debug));
      setIsLoading(false);
    }
  };

  const handleInput = async (value: string) => {
    if (isLoading) return;
    setInputValue('');
    setIsLoading(true);

    const trimmedInput = value.trim();
    if (!trimmedInput) return; // Ignore empty submissions
    if (isLoading) return; // Ignore input while loading
    if (trimmedInput.startsWith('/')) {
      const [command, ...args] = trimmedInput.slice(1).trim().split(' ');
      if (isCommand(command)) {
        await handleCommandAndUpdate(command, args);
        return;
      }
    }
    await handleCommandAndUpdate('user', [value]);
  };

  // --- Keyboard Input Hook (Focus, Navigation) ---
  useInput(
    async (input, key) => {
      // Handle Ctrl+C for exit (useApp's exit is preferred)
      if (key.ctrl && input === 'c') {
        onExit();
        return;
      }

      if (isLoading) return;

      switch (focusedElement) {
        case 'input': {
          if (key.return) {
            await handleInput(inputValue);
          } else if (key.upArrow && key.meta) {
            await handleCommandAndUpdate('up', []);
          } else if (key.leftArrow && key.meta) {
            await handleCommandAndUpdate('left', []);
          } else if (key.rightArrow && key.meta) {
            await handleCommandAndUpdate('right', []);
          } else if (key.downArrow && children.length > 0) {
            setFocusedElement('children');
            setSelectedChildIndex(0);
          }
          return;
        }
        case 'children': {
          if (children.length === 0) return;
          if (key.return) {
            // Navigate to selected child
            const selectedChild = sortedChildren[selectedChildIndex];
            if (selectedChild) {
              setCurrentNodeId(selectedChild.id);
              setFocusedElement('input'); // Return focus to input after navigation
            }
          } else if (key.upArrow) {
            if (selectedChildIndex > 0) {
              setSelectedChildIndex(prev => prev - 1);
            } else {
              // Move focus back to input when pressing Up from the first child
              setFocusedElement('input');
            }
          } else if (
            key.downArrow &&
            selectedChildIndex < children.length - 1
          ) {
            setSelectedChildIndex(prev => prev + 1);
          }
        }
      }
    },
    { isActive: true } // Ensure the hook is always active
  );

  // --- Child Sorting and Rendering Logic ---
  const sortedChildren = useMemo(() => {
    const unread: NodeData[] = [];
    const read: NodeData[] = [];
    if (!children) return [];

    children.forEach(child => {
      if (child.metadata.tags?.includes(UNREAD_TAG)) {
        unread.push(child);
      } else {
        read.push(child);
      }
    });
    return [...unread, ...read];
  }, [children]);

  // --- Rendering Logic ---

  const maxChildren = 5;

  const inputHeight = 1;
  const statusHeight = 3;
  const childrenMargin = 1;
  const childrenHeight = children.length
    ? Math.min(children.length, maxChildren) + 3
    : 0;
  const fixedElementsHeight =
    inputHeight + statusHeight + childrenMargin + childrenHeight;
  const historyHeight = Math.max(1, process.stdout.rows - fixedElementsHeight); // Ensure at least 1 row

  const context = [...history];
  if (focusedElement === 'children' && sortedChildren[selectedChildIndex]) {
    const previewMessage = sortedChildren[selectedChildIndex].message;
    context.push({
      ...previewMessage,
      nodeId: sortedChildren[selectedChildIndex].id,
      isChildPreview: true
    });
  }

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* 1. History View */}
      <Box flexDirection="column" height={historyHeight} overflowY="hidden">
        {root?.config.systemPrompt && (
          <Text color="magenta">[System] {root?.config.systemPrompt}</Text>
        )}
        {context.slice(-historyHeight).map((msg, index) => {
          const key = `${msg.nodeId}-${index}`;
          const color = msg.isChildPreview
            ? 'gray'
            : msg.role === 'user'
              ? 'green'
              : 'cyan';
          const text =
            msg.role == 'user' ? `[USER] ${msg.content}` : `${msg.content}`;
          return (
            <Text key={key} color={color}>
              {text}
            </Text>
          );
        })}
        {context.length > historyHeight && (
          <Text dimColor>
            ... ({context.length - historyHeight} older messages hidden)
          </Text>
        )}
        {/* spacer if history is short to push input down */}
        {context.length <= historyHeight && <Box flexGrow={1} />}
      </Box>

      {/* Status Line */}
      <Box
        borderStyle="round"
        borderColor={isLoading ? 'yellow' : error ? 'red' : 'gray'}
        paddingX={1}
      >
        {isLoading ? (
          <Text color={'yellow'}>...</Text>
        ) : error ? (
          <Text color="red">{error}</Text>
        ) : (
          <>
            <Text color="gray">
              [{root?.id}:{root?.config.model}] node {currentNodeId}
              {siblings.length > 1 &&
                `(${siblings.indexOf(currentNodeId) + 1}/${siblings.length})`}
            </Text>
          </>
        )}
      </Box>

      {/* 2. Input Field */}
      <Box>
        <Text color={focusedElement === 'input' ? 'blue' : 'grey'}>{'> '}</Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          focus={focusedElement === 'input'}
        />
      </Box>

      {/* 3. Children */}
      {sortedChildren.length > 0 && (
        <Box
          borderStyle="round"
          borderColor={focusedElement === 'children' ? 'blue' : 'grey'}
          flexDirection="column"
          paddingX={1}
          marginTop={childrenMargin}
          height={childrenHeight}
          overflowY="hidden"
        >
          <Text dimColor>Children:</Text>
          {sortedChildren
            .slice(0, Math.min(sortedChildren.length, maxChildren))
            .map((child, index) => {
              const isSelected =
                focusedElement === 'children' && index === selectedChildIndex;
              const isUnread =
                child.parent_id && child.metadata.tags?.includes(UNREAD_TAG);

              const rawPreview = `${isUnread ? '* ' : ''}[${child.id}] (${child.message.role}) ${child.message.content.replace(/\n/g, ' ')}`;
              const preview =
                rawPreview.substring(0, 80) +
                (rawPreview.length > 80 ? '...' : '');
              return (
                <Text
                  key={child.id}
                  color={isSelected ? 'blue' : undefined}
                  bold={isUnread}
                  inverse={isSelected}
                >
                  {preview}
                </Text>
              );
            })}
        </Box>
      )}
    </Box>
  );
}
