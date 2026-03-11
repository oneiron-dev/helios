import { Box, Text } from "ink";
import type { StickyNote } from "../../core/stickies.js";
import { C } from "../theme.js";

interface StickyNotesPanelProps {
  notes: StickyNote[];
  width: number;
}

export function StickyNotesPanel({ notes, width }: StickyNotesPanelProps) {
  if (notes.length === 0) return null;

  const inner = width - 4; // 2 for border, 2 for padding

  const label = "─ STICKIES ";
  const topBorder = "┌" + label + "─".repeat(Math.max(0, width - 2 - label.length)) + "┐";

  return (
    <Box flexDirection="column" width={width}>
      <Text color={C.primary}>
        {topBorder}
      </Text>

      {notes.map((note) => (
        <StickyNoteItem key={note.num} note={note} innerWidth={inner} borderWidth={width} />
      ))}

      <Text color={C.primary}>
        {"└" + "─".repeat(width - 2) + "┘"}
      </Text>
    </Box>
  );
}

function StickyNoteItem({
  note,
  innerWidth,
  borderWidth,
}: {
  note: StickyNote;
  innerWidth: number;
  borderWidth: number;
}) {
  const label = `${note.num}. `;
  const textWidth = innerWidth - label.length;
  const wrapped = wrapText(note.text, textWidth);

  return (
    <>
      {wrapped.map((line, i) => {
        const prefix = i === 0 ? label : " ".repeat(label.length);
        const content = prefix + line;
        return (
          <Text key={`${note.num}-${i}`} color={C.primary}>
            {"│"}{" "}<Text color={i === 0 ? C.bright : C.text} bold={i === 0}>{pad(content, borderWidth - 4)}</Text>{" "}{"│"}
          </Text>
        );
      })}
      <Text color={C.primary}>
        {"│" + " ".repeat(borderWidth - 2) + "│"}
      </Text>
    </>
  );
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  const words = text.split(" ");
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}
