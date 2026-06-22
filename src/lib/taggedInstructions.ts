export function isTaggedUserInstruction(text: string) {
  const contentStart = taggedInstructionContentStart(text);
  if (contentStart === null) {
    return false;
  }

  if (isInlineTaggedInstructionSequence(text, contentStart)) {
    return true;
  }

  const firstLineEnd = text.indexOf("\n", contentStart);
  if (firstLineEnd === -1) {
    return false;
  }

  const lastLineStart = text.lastIndexOf("\n") + 1;
  const firstLine = trimHorizontalWhitespace(
    stripTrailingCarriageReturn(text.slice(contentStart, firstLineEnd)),
  );
  const lastLine = trimHorizontalWhitespace(text.slice(lastLineStart));
  const openingTag = parseOpeningTag(firstLine);
  return openingTag !== null && parseClosingTag(lastLine) === openingTag;
}

function isInlineTaggedInstructionSequence(text: string, contentStart: number) {
  let sawTag = false;
  for (const rawLine of text.slice(contentStart).split("\n")) {
    const line = trimHorizontalWhitespace(stripTrailingCarriageReturn(rawLine));
    if (line.length === 0) {
      continue;
    }
    if (parseInlineTag(line) === null) {
      return false;
    }
    sawTag = true;
  }
  return sawTag;
}

function taggedInstructionContentStart(text: string) {
  let start = 0;
  while (start < text.length) {
    const lineEnd = text.indexOf("\n", start);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = stripTrailingCarriageReturn(text.slice(start, end));
    if (!isTaggedInstructionPrefixLine(line)) {
      return start;
    }
    if (lineEnd === -1) {
      return null;
    }
    start = lineEnd + 1;
  }
  return null;
}

function isTaggedInstructionPrefixLine(line: string) {
  return line.startsWith("# ") || trimHorizontalWhitespace(line).length === 0;
}

function stripTrailingCarriageReturn(value: string) {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function trimHorizontalWhitespace(value: string) {
  let start = 0;
  let end = value.length;
  while (start < end && isHorizontalWhitespace(value[start])) {
    start += 1;
  }
  while (end > start && isHorizontalWhitespace(value[end - 1])) {
    end -= 1;
  }
  return value.slice(start, end);
}

function isHorizontalWhitespace(char: string) {
  return char !== "\n" && char !== "\r" && char.trim() === "";
}

function parseInlineTag(line: string) {
  if (line.length < 7 || line[0] !== "<") {
    return null;
  }
  const openingEnd = line.indexOf(">");
  if (openingEnd < 2) {
    return null;
  }
  const tag = line.slice(1, openingEnd);
  if (!isInstructionTagName(tag)) {
    return null;
  }
  const closing = `</${tag}>`;
  return line.endsWith(closing) ? tag : null;
}

function parseOpeningTag(line: string) {
  if (line.length < 3 || line[0] !== "<" || line[line.length - 1] !== ">") {
    return null;
  }
  const tag = line.slice(1, -1);
  return isInstructionTagName(tag) ? tag : null;
}

function parseClosingTag(line: string) {
  if (line.length < 4 || line.slice(0, 2) !== "</" || line[line.length - 1] !== ">") {
    return null;
  }
  const tag = line.slice(2, -1);
  return isInstructionTagName(tag) ? tag : null;
}

function isInstructionTagName(tag: string) {
  if (tag.length === 0) {
    return false;
  }
  for (const char of tag) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower && char !== "_" && char !== "-") {
      return false;
    }
  }
  return true;
}
