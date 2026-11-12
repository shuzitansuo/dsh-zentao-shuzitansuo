// Document ingestion for batch requirement creation.
//
// Supports Markdown, plain text and Word .docx. Docx is read without any
// third-party dependency: unzip the container, decompress word/document.xml
// and map its paragraphs to lines, then reuse the text parser.

import zlib from 'node:zlib';

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function readZipEntry(buf, target) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 docx 文件（缺少 zip 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  let pointer = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pointer + 10);
    const compressedSize = buf.readUInt32LE(pointer + 20);
    const nameLength = buf.readUInt16LE(pointer + 28);
    const extraLength = buf.readUInt16LE(pointer + 30);
    const commentLength = buf.readUInt16LE(pointer + 32);
    const localOffset = buf.readUInt32LE(pointer + 42);
    const name = buf.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    if (name === target) {
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('docx 使用了不支持的压缩方式');
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('docx 里没有找到正文（word/document.xml）');
}

function docxParagraphs(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml').toString('utf8');
  const paragraphs = [];
  for (const para of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const pieces = [];
    for (const piece of para[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)) {
      pieces.push(decodeEntities(piece[1]));
    }
    for (const tab of para[0].matchAll(/<w:tab\/>/g)) pieces.push('\t');
    const style = para[0].match(/<w:pStyle[^>]*w:val="([^"]*)"/);
    const outline = para[0].match(/<w:outlineLvl[^>]*w:val="([0-9])"/);
    const styleValue = style ? style[1] : '';
    const headingByStyle = /(?:^|[^a-z])[Hh]eading\s*([1-6])/.test(styleValue) || /[Hh]eading([1-6])/.test(styleValue);
    const heading = headingByStyle || (outline && Number(outline[1]) <= 5) || /^[1-6]$/.test(styleValue);
    paragraphs.push({ text: pieces.join(''), heading: Boolean(heading) });
  }
  return paragraphs;
}

/** Extract plain text from a .docx buffer. */
export function docxToText(buffer) {
  return docxParagraphs(buffer)
    .map((para) => para.text)
    .join('\n');
}

/** Build requirement drafts from a .docx buffer using Word heading styles. */
export function docxToItems(buffer) {
  const paragraphs = docxParagraphs(buffer);
  const items = [];
  let current = null;
  for (const para of paragraphs) {
    const text = para.text.trim();
    if (!text) {
      if (current) current.body.push('');
      continue;
    }
    if (para.heading) {
      if (current) items.push(current);
      current = { title: text.slice(0, 120), body: [] };
    } else if (current) {
      current.body.push(text);
    } else {
      current = { title: text.slice(0, 120), body: [] };
    }
  }
  if (current) items.push(current);
  const named = items
    .filter((item) => item.title)
    .map((item) => ({ title: item.title, description: item.body.join('\n').trim() }));
  if (named.length >= 2) return named;
  // No usable heading styles: reuse the text parser on paragraph blocks.
  const text = paragraphs.map((para) => para.text).join('\n\n');
  return parseRequirements(text);
}

/**
 * Split document text into requirement drafts.
 * Priority: markdown headings → numbered sections → blank-line paragraphs.
 * @returns {title, description}[] where description is the section body.
 */
export function parseRequirements(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const items = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const title = current.title.trim();
    if (title) items.push({ title: title.slice(0, 120), description: current.body.join('\n').trim() });
    current = null;
  };

  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
  const numbered = /^\s*(?:\d+[.、)）]|[一二三四五六七八九十]+[、.）)])\s*(.+)$/;
  let headingCount = 0;
  for (const line of lines) {
    const match = line.match(heading);
    if (match) {
      headingCount += 1;
      flush();
      current = { title: match[1], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  if (headingCount >= 2 && items.length >= 2) return items;

  // Numbered sections (txt / plain Word outline).
  items.length = 0;
  let numberedCurrent = null;
  const flushNumbered = () => {
    if (!numberedCurrent) return;
    const title = numberedCurrent.title.trim();
    if (title) items.push({ title: title.slice(0, 120), description: numberedCurrent.body.join('\n').trim() });
    numberedCurrent = null;
  };
  let numberedCount = 0;
  for (const line of lines) {
    const match = line.match(numbered);
    if (match) {
      numberedCount += 1;
      flushNumbered();
      numberedCurrent = { title: match[1], body: [] };
    } else if (numberedCurrent) {
      numberedCurrent.body.push(line);
    }
  }
  flushNumbered();
  if (numberedCount >= 2 && items.length >= 2) return items;

  // Fallback: paragraphs separated by blank lines; first line is the title.
  const paragraphs = String(text || '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2) {
    return paragraphs.map((block) => {
      const blockLines = block.split('\n');
      return { title: blockLines[0].trim().slice(0, 120), description: blockLines.slice(1).join('\n').trim() };
    });
  }
  const firstLine = (lines.find((line) => line.trim()) || '').trim();
  if (!firstLine) return [];
  return [{ title: firstLine.slice(0, 120), description: String(text || '').trim() }];
}

/**
 * Parse an uploaded document into requirement drafts.
 * @param name - original file name (used to pick the format).
 * @param base64 - file content.
 * @returns {format, items, text}
 */
export function parseDocument(name, base64) {
  const lower = String(name || '').toLowerCase();
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  if (!buffer.length) throw new Error('文件是空的');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('文件太大（上限 8MB）');
  let text = '';
  let format = 'txt';
  if (lower.endsWith('.docx')) {
    format = 'docx';
    text = docxToText(buffer);
    const docxItems = docxToItems(buffer).slice(0, 50);
    if (!docxItems.length) throw new Error('没有从文档里解析出需求内容');
    return { format, items: docxItems, text: text.slice(0, 200000) };
  } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    format = 'md';
    text = buffer.toString('utf8');
  } else if (lower.endsWith('.txt')) {
    format = 'txt';
    text = buffer.toString('utf8');
  } else if (lower.endsWith('.doc')) {
    throw new Error('暂不支持旧版 .doc，请在 Word 里另存为 .docx 或 .txt 后再上传');
  } else {
    throw new Error('只支持 .md、.txt、.docx 文件');
  }
  const items = parseRequirements(text).slice(0, 50);
  if (!items.length) throw new Error('没有从文档里解析出需求内容');
  return { format, items, text: text.slice(0, 200000) };
}
