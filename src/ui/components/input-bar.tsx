import { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { C, G } from "../theme.js";
import { COMMANDS, type SlashCommand } from "../commands.js";

interface InputBarProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputBar({
  onSubmit,
  disabled = false,
  placeholder = "send a message...",
}: InputBarProps) {
  const [value, setValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const isCommandMode = value.startsWith("/");
  const commandQuery = isCommandMode ? value.slice(1).split(" ")[0] : "";
  const hasArgs = isCommandMode && value.includes(" ");

  const filteredCommands = useMemo(() => {
    if (!isCommandMode || hasArgs) return [];
    if (commandQuery === "") return COMMANDS;
    return COMMANDS.filter((cmd) => cmd.name.startsWith(commandQuery));
  }, [isCommandMode, commandQuery, hasArgs]);

  const showMenu = isCommandMode && !hasArgs && filteredCommands.length > 0;

  useInput((input, key) => {
    if (disabled) return;

    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        setHistory((prev) => [value.trim(), ...prev]);
        setValue("");
        setCursorPos(0);
        setHistoryIdx(-1);
        setSelectedIdx(0);
      }
      return;
    }

    if (key.tab && showMenu) {
      const cmd = filteredCommands[selectedIdx];
      if (cmd) {
        const completed = `/${cmd.name}${cmd.args ? " " : ""}`;
        setValue(completed);
        setCursorPos(completed.length);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        setValue((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
        setCursorPos((prev) => prev - 1);
      }
      setSelectedIdx(0);
      return;
    }

    // Left arrow
    if (key.leftArrow) {
      setCursorPos((prev) => Math.max(0, prev - 1));
      return;
    }

    // Right arrow
    if (key.rightArrow) {
      setCursorPos((prev) => Math.min(value.length, prev + 1));
      return;
    }

    if (key.upArrow) {
      if (showMenu) {
        setSelectedIdx((prev) =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1,
        );
      } else if (history.length > 0) {
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(newIdx);
        setValue(history[newIdx]);
        setCursorPos(history[newIdx].length);
      }
      return;
    }

    if (key.downArrow) {
      if (showMenu) {
        setSelectedIdx((prev) =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0,
        );
      } else {
        if (historyIdx <= 0) {
          setHistoryIdx(-1);
          setValue("");
          setCursorPos(0);
        } else {
          const newIdx = historyIdx - 1;
          setHistoryIdx(newIdx);
          setValue(history[newIdx]);
          setCursorPos(history[newIdx].length);
        }
      }
      return;
    }

    // Home / Ctrl+A
    if (key.ctrl && input === "a") {
      setCursorPos(0);
      return;
    }

    // End / Ctrl+E
    if (key.ctrl && input === "e") {
      setCursorPos(value.length);
      return;
    }

    // Ctrl+U — clear line
    if (key.ctrl && input === "u") {
      setValue("");
      setCursorPos(0);
      return;
    }

    // Ctrl+W — delete word backward
    if (key.ctrl && input === "w") {
      const before = value.slice(0, cursorPos);
      const after = value.slice(cursorPos);
      const trimmed = before.replace(/\S+\s*$/, "");
      setValue(trimmed + after);
      setCursorPos(trimmed.length);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setValue((prev) => prev.slice(0, cursorPos) + input + prev.slice(cursorPos));
      setCursorPos((prev) => prev + input.length);
      setHistoryIdx(-1);
      setSelectedIdx(0);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Command autocomplete menu */}
      {showMenu && (
        <Box flexDirection="column" paddingX={1} paddingY={0}>
          {filteredCommands.map((cmd, i) => (
            <CommandItem
              key={cmd.name}
              command={cmd}
              selected={i === selectedIdx}
            />
          ))}
          <Text color={C.dim} dimColor>
            {"  "}↑↓ navigate{"  "}tab complete{"  "}enter run
          </Text>
        </Box>
      )}

      {/* Input line */}
      <Box paddingX={1}>
        <Text color={C.primary} bold>
          {G.active}{" "}
        </Text>
        {value ? (
          <CursorText text={value} cursorPos={cursorPos} />
        ) : (
          <Text color={C.dim} dimColor>
            {disabled ? "waiting..." : placeholder}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function CursorText({ text, cursorPos }: { text: string; cursorPos: number }) {
  const before = text.slice(0, cursorPos);
  const cursor = text[cursorPos] ?? " ";
  const after = text.slice(cursorPos + 1);

  return (
    <Text>
      <Text color={C.text}>{before}</Text>
      <Text color="black" backgroundColor={C.primary}>{cursor}</Text>
      <Text color={C.text}>{after}</Text>
    </Text>
  );
}

function CommandItem({
  command,
  selected,
}: {
  command: SlashCommand;
  selected: boolean;
}) {
  const argStr = command.args ? ` ${command.args}` : "";
  return (
    <Box>
      <Text
        color={selected ? C.primary : C.dim}
        bold={selected}
      >
        {selected ? `${G.active} ` : "  "}
        /{command.name}
      </Text>
      {command.args && (
        <Text color={C.dim}>{argStr}</Text>
      )}
      <Text color={C.dim} dimColor>
        {"  "}{command.description}
      </Text>
    </Box>
  );
}
