import { Fragment, type ReactNode } from 'react';

/**
 * A deliberately small Markdown renderer for reports (headings, paragraphs, lists,
 * fenced code, tables, bold/italic/inline code). It builds React elements only — no
 * `dangerouslySetInnerHTML`, no raw HTML passthrough, links shown as plain text — so a
 * report containing `<script>` or `<img onerror>` is displayed as text, never executed
 * (reports are written by an AI agent and treated as untrusted content).
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Emphasis markers only count at word boundaries, so identifiers such as
  // SESSION_ID / 2026-09-26_001 or a*b*c stay literal text.
  const pattern = /(`[^`]+`)|(?<![\w*])(\*\*[^*]+\*\*)(?![\w*])|(?<![\w*])(\*[^*\s][^*]*?\*)(?![\w*])|(?<![\w_])(_[^_\s][^_]*?_)(?![\w_])/g;
  let last = 0;
  let i = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    if (/^```/.test(line.trim())) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="md-code">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={key++}>{renderInline(heading[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') rows.push(splitRow(lines[i++]));
      const k = key++;
      blocks.push(
        <table key={k} className="md-table">
          <thead>
            <tr>
              {header.map((h, c) => (
                <th key={c}>{renderInline(h, `th${k}-${c}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((cell, c) => (
                  <td key={c}>{renderInline(cell, `td${k}-${ri}-${c}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) items.push(lines[i++].replace(LIST_ITEM, ''));
      const k = key++;
      const children = items.map((item, n) => <li key={n}>{renderInline(item, `li${k}-${n}`)}</li>);
      blocks.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```)/.test(lines[i]) && !LIST_ITEM.test(lines[i])) para.push(lines[i++]);
    const k = key++;
    blocks.push(
      <p key={k}>
        {para.map((p, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {renderInline(p, `p${k}-${n}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="markdown">{blocks}</div>;
}
