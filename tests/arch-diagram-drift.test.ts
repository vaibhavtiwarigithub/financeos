import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Diagram drift gate — one source per fact.
 *
 * Agent-to-agent TOPOLOGY lives in exactly one place: public/agent-diagrams/system-map.json
 * (it renders at /dashboard/agents -> "System Map" and carries a history audit trail).
 * When a docs/arch chapter restates the same edges in its own mermaid block, the fact has two
 * homes and they rot apart. That already happened: both the map and docs/arch/03-agents.md
 * asserted `MACRO --> RESEARCH` unqualified, which the India-macro fix made false (macro_score
 * is US-only; India's macro dimension is UNAVAILABLE and excluded). The duplicate did not add
 * safety — it gave the stale claim a second place to hide.
 *
 * This gate is deliberately narrow. A chapter diagram is LEGITIMATE when it shows something the
 * system map does not: a decision ladder (08), a loop told at a different altitude (09), an
 * onboarding abstraction (01), a worked example. Those legitimately share node PAIRS with the
 * map, so a blanket "no shared edges" rule would false-positive and be deleted by the next
 * person. Overlap is therefore allowed — but only as a DECLARED, reviewable choice recorded in
 * DECLARED_OVERLAPS below, with a reason. Adding an entry is the conscious opt-out; adding
 * duplicated topology without one fails.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const ARCH_DIR = path.join(REPO_ROOT, 'docs', 'arch');
const DIAGRAM_DIR = path.join(REPO_ROOT, 'public', 'agent-diagrams');
const SYSTEM_MAP = path.join(DIAGRAM_DIR, 'system-map.json');

/**
 * Chapter mermaid blocks that intentionally re-use system-map node ids and edges.
 * Key: `<chapter file>#<0-based index of the mermaid block in that file>`.
 *
 * Each entry must state WHY the diagram shows something the system map does not. An entry whose
 * diagram no longer overlaps (or no longer exists) fails the "no stale exemptions" test below,
 * so this list cannot silently rot into a blanket amnesty.
 */
const DECLARED_OVERLAPS: Record<string, string> = {
  '01-what-is-kairos.md#0':
    'Onboarding abstraction, not topology: collapses the real graph into a "wheel" with nodes ' +
    'that do not exist in the map (DATA/SIGNALS/OUTCOMES) and deliberately skips CHALLENGER. ' +
    'It teaches the feedback loop to a newcomer; it is not a statement of how agents wire up.',
  '09-learning-loop.md#0':
    "The learning loop's own story at its own altitude: learner -> challenger -> shadow -> " +
    'validate -> promote -> champion -> outcomes. The chapter exists to explain this loop, so ' +
    'the loop is its subject, not a restatement of the map. It adds ARCHIVE and the shadow/ ' +
    'validate split that the map does not narrate.',
};

// ---------------------------------------------------------------------------
// mermaid edge extraction
// ---------------------------------------------------------------------------

/** Strip node labels and edge labels so only `ID <arrow> ID` skeletons remain. */
function stripLabels(diagram: string): string {
  return (
    diagram
      // quoted node labels first — these may contain newlines, brackets, pipes, arrows
      .replace(/\["[\s\S]*?"\]/g, '')
      .replace(/\("[\s\S]*?"\)/g, '')
      .replace(/\{"[\s\S]*?"\}/g, '')
      // unquoted shaped labels
      .replace(/\(\([^)]*\)\)/g, '')
      .replace(/\[\([^)]*\)\]/g, '')
      .replace(/\[[^[\]]*\]/g, '')
      .replace(/\{[^{}]*\}/g, '')
      .replace(/\([^()]*\)/g, '')
      // mid-arrow edge text: `-- text -->`, `-. text .->`, `== text ==>`
      .replace(/--[^->|]*?-->/g, ' --> ')
      .replace(/-\.[^.>|]*\.->/g, ' -.-> ')
      .replace(/==[^=>|]*?==>/g, ' ==> ')
      // pipe edge labels: `-->|text| B`
      .replace(/\|[^|]*\|/g, ' ')
  );
}

const ARROW = /(-\.->|-{2,}>|={2,}>|-\.-|-{3,}|={3,}|--o|--x)/;
const ID_AT_END = /([A-Za-z][A-Za-z0-9_-]*)\s*$/;
const ID_AT_START = /^\s*([A-Za-z][A-Za-z0-9_-]*)/;
/** mermaid keywords that are not node ids */
const KEYWORDS = new Set(['flowchart', 'graph', 'subgraph', 'end', 'direction', 'classDef', 'class', 'style', 'click']);

export type Edge = { from: string; to: string };

/** Parse a mermaid flowchart into directed `from -> to` edges by node id. Handles chains. */
export function parseMermaidEdges(diagram: string): Edge[] {
  const edges: Edge[] = [];
  for (const rawLine of stripLabels(diagram).split('\n')) {
    const line = rawLine.replace(/%%.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(new RegExp(ARROW.source, 'g'));
    if (parts.length < 3) continue;
    // parts = [seg, arrow, seg, arrow, seg, ...]
    for (let i = 1; i < parts.length; i += 2) {
      const left = ID_AT_END.exec(parts[i - 1])?.[1];
      const right = ID_AT_START.exec(parts[i + 1] ?? '')?.[1];
      if (!left || !right) continue;
      if (KEYWORDS.has(left) || KEYWORDS.has(right)) continue;
      edges.push({ from: left, to: right });
    }
  }
  return edges;
}

const key = (e: Edge) => `${e.from} --> ${e.to}`;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function readDiagramFile(file: string) {
  return JSON.parse(fs.readFileSync(path.join(DIAGRAM_DIR, file), 'utf8'));
}

const diagramFiles = fs.readdirSync(DIAGRAM_DIR).filter((f) => f.endsWith('.json'));

const systemMap = JSON.parse(fs.readFileSync(SYSTEM_MAP, 'utf8'));
const mapEdges = new Set(parseMermaidEdges(systemMap.diagram).map(key));
const mapNodeIds = new Set(Object.keys(systemMap.nodes));

/** Every mermaid block in every arch chapter, in file order. */
function collectChapterDiagrams(): { id: string; file: string; index: number; body: string }[] {
  const out: { id: string; file: string; index: number; body: string }[] = [];
  for (const file of fs.readdirSync(ARCH_DIR).filter((f) => f.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(ARCH_DIR, file), 'utf8').replace(/\r\n/g, '\n');
    const blocks = text.match(/```mermaid\n[\s\S]*?```/g) ?? [];
    blocks.forEach((block, index) => {
      out.push({ id: `${file}#${index}`, file, index, body: block.replace(/^```mermaid\n/, '').replace(/```$/, '') });
    });
  }
  return out;
}

const chapterDiagrams = collectChapterDiagrams();

/** Edges a chapter diagram shares with the system map (both endpoints are map node ids). */
function overlappingEdges(body: string): string[] {
  return parseMermaidEdges(body)
    .filter((e) => mapNodeIds.has(e.from) && mapNodeIds.has(e.to) && mapEdges.has(key(e)))
    .map(key);
}

// ---------------------------------------------------------------------------
// 0. the parser itself must work — a parser that finds nothing can never fail
// ---------------------------------------------------------------------------

describe('mermaid edge parser', () => {
  it('extracts plain, dotted, labelled, mid-text, and chained edges', () => {
    const edges = parseMermaidEdges(
      [
        'flowchart LR',
        '  MACRO[MacroSentinel] --> |macro_signals| RESEARCH[ResearchAgent]',
        '  RESEARCH -.->|records what would happen| SHADOW["Shadow\\ndecisions"]',
        '  VALIDATE -- passes gates --> PROMOTE{You promote?}',
        '  SIGNALS -.approved by you.-> LIVE[Live order]',
        '  RESEARCH --> OUTCOMES[new closed trades] --> LEARNER',
        '  VALIDATE -->|evidence| USER((You))',
      ].join('\n'),
    ).map(key);
    expect(edges).toEqual([
      'MACRO --> RESEARCH',
      'RESEARCH --> SHADOW',
      'VALIDATE --> PROMOTE',
      'SIGNALS --> LIVE',
      'RESEARCH --> OUTCOMES',
      'OUTCOMES --> LEARNER',
      'VALIDATE --> USER',
    ]);
  });

  it('reads a non-trivial edge set out of the real system map', () => {
    expect(mapEdges.size).toBeGreaterThan(20);
    expect(mapEdges.has('MACRO --> RESEARCH')).toBe(true);
    expect(mapEdges.has('CHAMPION --> RESEARCH')).toBe(true);
  });

  it('does not depict autonomous live execution as active while its deployment gate is off', () => {
    expect(systemMap.diagram).toContain('AutonomousLive (DORMANT)');
    expect(systemMap.nodes.AUTOLIVE.label).toBe('AutonomousLive (dormant)');
    expect(systemMap.nodes.AUTOLIVE.description).toContain('AUTONOMOUS_LIVE_ENABLED=false');
  });
});

// ---------------------------------------------------------------------------
// 1. no arch chapter restates system-map topology
// ---------------------------------------------------------------------------

describe('docs/arch chapters do not duplicate system-map topology', () => {
  it('finds arch chapter diagrams to check', () => {
    expect(chapterDiagrams.length).toBeGreaterThan(0);
  });

  it.each(chapterDiagrams.map((d) => [d.id, d] as const))('%s', (_id, d) => {
    const overlap = overlappingEdges(d.body);
    if (DECLARED_OVERLAPS[d.id]) return; // declared, reviewed, and reason-bearing
    expect(
      overlap,
      `${d.file} (mermaid block #${d.index}) re-declares agent-to-agent edges that ` +
        `public/agent-diagrams/system-map.json already declares. Topology has one home: the ` +
        `system map (rendered at /dashboard/agents -> "System Map"). Either point at the map ` +
        `instead of redrawing it, or — if this diagram genuinely shows something the map does ` +
        `not (a sequence, a gate ladder, a narrower altitude) — add "${d.id}" to ` +
        `DECLARED_OVERLAPS in tests/arch-diagram-drift.test.ts with the reason.`,
    ).toEqual([]);
  });

  it('has no stale DECLARED_OVERLAPS entries', () => {
    const stale = Object.keys(DECLARED_OVERLAPS).filter((id) => {
      const d = chapterDiagrams.find((c) => c.id === id);
      return !d || overlappingEdges(d.body).length === 0;
    });
    expect(
      stale,
      'These DECLARED_OVERLAPS entries no longer describe an overlapping diagram (it was ' +
        'removed, renumbered, or cleaned up). Delete them — an exemption list that outlives its ' +
        'reason becomes a blanket amnesty.',
    ).toEqual([]);
  });

  it('every declared overlap carries a reason', () => {
    for (const [id, reason] of Object.entries(DECLARED_OVERLAPS)) {
      expect(reason.trim().length, `${id} needs a real reason`).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. every agent diagram is well formed — a malformed file breaks /dashboard/agents
// ---------------------------------------------------------------------------

describe('public/agent-diagrams/*.json contract', () => {
  it('finds the diagram files', () => {
    expect(diagramFiles).toContain('system-map.json');
    expect(diagramFiles.length).toBeGreaterThan(1);
  });

  it.each(diagramFiles)('%s', (file) => {
    let parsed: unknown;
    expect(() => {
      parsed = readDiagramFile(file);
    }, `${file} is not valid JSON — /dashboard/agents fails to render it`).not.toThrow();

    const d = parsed as Record<string, unknown>;
    for (const k of ['agentId', 'agentLabel', 'diagram', 'nodes', 'history']) {
      expect(d[k], `${file} is missing "${k}"`).toBeDefined();
    }
    expect(typeof d.agentId, `${file}.agentId must be a string`).toBe('string');
    expect(typeof d.agentLabel, `${file}.agentLabel must be a string`).toBe('string');
    expect(typeof d.diagram, `${file}.diagram must be a mermaid string`).toBe('string');
    expect((d.diagram as string).trim().length, `${file}.diagram is empty`).toBeGreaterThan(0);

    // nodes must be an OBJECT KEYED BY NODE ID, not an array — the renderer looks nodes up by id
    expect(Array.isArray(d.nodes), `${file}.nodes must be an object keyed by node id, not an array`).toBe(false);
    expect(typeof d.nodes, `${file}.nodes must be an object keyed by node id`).toBe('object');
    expect(d.nodes, `${file}.nodes must not be null`).not.toBeNull();
    const nodeIds = Object.keys(d.nodes as object);
    expect(nodeIds.length, `${file}.nodes is empty`).toBeGreaterThan(0);
    for (const id of nodeIds) {
      expect(id, `${file}.nodes has a non-id key "${id}"`).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    }

    expect(Array.isArray(d.history), `${file}.history must be an array`).toBe(true);
    expect((d.history as unknown[]).length, `${file}.history must not be empty — it is the audit trail`).toBeGreaterThan(0);
  });
});
