/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { escapeRegExp, longestCommonSubstring, normalizeWhiteSpace } from '@isomorphic/stringUtils';

import { box, getElementComputedStyle, getGlobalOptions, isElementVisible } from './domUtils';
import * as roleUtils from './roleUtils';
import { yamlEscapeKeyIfNeeded, yamlEscapeValueIfNeeded } from './yaml';

import type { AriaProps, AriaRegex, AriaRole, AriaTemplateNode, AriaTemplateRoleNode, AriaTemplateTextNode } from '@isomorphic/ariaSnapshot';
import type { Box } from './domUtils';

export type AriaNode = AriaProps & {
  role: AriaRole | 'fragment' | 'iframe';
  name: string;
  ref?: string;
  children: (AriaNode | string)[];
  element: Element;
  box: Box;
  receivesPointerEvents: boolean;
  props: Record<string, string>;
};

export type AriaSnapshot = {
  root: AriaNode;
  elements: Map<string, Element>;
};

type AriaRef = {
  role: string;
  name: string;
  ref: string;
};

const STRING_SIMILARITY_MAX_SCORE = 400;
const ROLE_MATCH_SCORE = 500;
const ALL_FIELDS_MATCH_SCORE = 500;
const FIELD_MATCH_SCORE = 100;
const NO_CHILDREN_PENALTY = -50;
const INDEX_MATCH_BONUS_SCORE = 200;
const INDEX_MISMATCH_PENALTY = -50;
const DEPTH_BONUS_SCORE = 20;
const COUNT_MATCH_SCORE = 300;
const EXACT_MATCH_SCORE = 1000;
const NO_MATCH_SCORE = -200;

let lastRef = 0;

export function generateAriaTree(rootElement: Element, options?: { forAI?: boolean, refPrefix?: string }): AriaSnapshot {
  const visited = new Set<Node>();

  const snapshot: AriaSnapshot = {
    root: { role: 'fragment', name: '', children: [], element: rootElement, props: {}, box: box(rootElement), receivesPointerEvents: true },
    elements: new Map<string, Element>(),
  };

  const visit = (ariaNode: AriaNode, node: Node) => {
    if (visited.has(node))
      return;
    visited.add(node);

    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
      const text = node.nodeValue;
      // <textarea>AAA</textarea> should not report AAA as a child of the textarea.
      if (ariaNode.role !== 'textbox' && text)
        ariaNode.children.push(node.nodeValue || '');
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE)
      return;

    const element = node as Element;
    let isVisible = !roleUtils.isElementHiddenForAria(element);
    if (options?.forAI)
      isVisible = isVisible || isElementVisible(element);
    if (!isVisible)
      return;

    const ariaChildren: Element[] = [];
    if (element.hasAttribute('aria-owns')) {
      const ids = element.getAttribute('aria-owns')!.split(/\s+/);
      for (const id of ids) {
        const ownedElement = rootElement.ownerDocument.getElementById(id);
        if (ownedElement)
          ariaChildren.push(ownedElement);
      }
    }

    const childAriaNode = toAriaNode(element, options);
    if (childAriaNode) {
      if (childAriaNode.ref)
        snapshot.elements.set(childAriaNode.ref, element);
      ariaNode.children.push(childAriaNode);
    }
    processElement(childAriaNode || ariaNode, element, ariaChildren);
  };

  function processElement(ariaNode: AriaNode, element: Element, ariaChildren: Element[] = []) {
    // Surround every element with spaces for the sake of concatenated text nodes.
    const display = getElementComputedStyle(element)?.display || 'inline';
    const treatAsBlock = (display !== 'inline' || element.nodeName === 'BR') ? ' ' : '';
    if (treatAsBlock)
      ariaNode.children.push(treatAsBlock);

    ariaNode.children.push(roleUtils.getCSSContent(element, '::before') || '');
    const assignedNodes = element.nodeName === 'SLOT' ? (element as HTMLSlotElement).assignedNodes() : [];
    if (assignedNodes.length) {
      for (const child of assignedNodes)
        visit(ariaNode, child);
    } else {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (!(child as Element | Text).assignedSlot)
          visit(ariaNode, child);
      }
      if (element.shadowRoot) {
        for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling)
          visit(ariaNode, child);
      }
    }

    for (const child of ariaChildren)
      visit(ariaNode, child);

    ariaNode.children.push(roleUtils.getCSSContent(element, '::after') || '');

    if (treatAsBlock)
      ariaNode.children.push(treatAsBlock);

    if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0])
      ariaNode.children = [];

    if (ariaNode.role === 'link' && element.hasAttribute('href')) {
      const href = element.getAttribute('href')!;
      ariaNode.props['url'] = href;
    }
  }

  roleUtils.beginAriaCaches();
  try {
    visit(snapshot.root, rootElement);
  } finally {
    roleUtils.endAriaCaches();
  }

  normalizeStringChildren(snapshot.root);
  normalizeGenericRoles(snapshot.root);
  return snapshot;
}

function ariaRef(element: Element, role: string, name: string, options?: { forAI?: boolean, refPrefix?: string }): string | undefined {
  if (!options?.forAI)
    return undefined;

  let ariaRef: AriaRef | undefined;
  ariaRef = (element as any)._ariaRef;
  if (!ariaRef || ariaRef.role !== role || ariaRef.name !== name) {
    ariaRef = { role, name, ref: (options?.refPrefix ?? '') + 'e' + (++lastRef) };
    (element as any)._ariaRef = ariaRef;
  }
  return ariaRef.ref;
}

function toAriaNode(element: Element, options?: { forAI?: boolean, refPrefix?: string }): AriaNode | null {
  if (element.nodeName === 'IFRAME') {
    return {
      role: 'iframe',
      name: '',
      ref: ariaRef(element, 'iframe', '', options),
      children: [],
      props: {},
      element,
      box: box(element),
      receivesPointerEvents: true
    };
  }

  const defaultRole = options?.forAI ? 'generic' : null;
  const role = roleUtils.getAriaRole(element) ?? defaultRole;
  if (!role || role === 'presentation' || role === 'none')
    return null;

  const name = normalizeWhiteSpace(roleUtils.getElementAccessibleName(element, false) || '');
  const receivesPointerEvents = roleUtils.receivesPointerEvents(element);

  const result: AriaNode = {
    role,
    name,
    ref: ariaRef(element, role, name, options),
    children: [],
    props: {},
    element,
    box: box(element),
    receivesPointerEvents
  };

  if (roleUtils.kAriaCheckedRoles.includes(role))
    result.checked = roleUtils.getAriaChecked(element);

  if (roleUtils.kAriaDisabledRoles.includes(role))
    result.disabled = roleUtils.getAriaDisabled(element);

  if (roleUtils.kAriaExpandedRoles.includes(role))
    result.expanded = roleUtils.getAriaExpanded(element);

  if (roleUtils.kAriaLevelRoles.includes(role))
    result.level = roleUtils.getAriaLevel(element);

  if (roleUtils.kAriaPressedRoles.includes(role))
    result.pressed = roleUtils.getAriaPressed(element);

  if (roleUtils.kAriaSelectedRoles.includes(role))
    result.selected = roleUtils.getAriaSelected(element);

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.type !== 'checkbox' && element.type !== 'radio' && (element.type !== 'file' || getGlobalOptions().inputFileRoleTextbox))
      result.children = [element.value];
  }

  return result;
}

function normalizeGenericRoles(node: AriaNode) {
  const normalizeChildren = (node: AriaNode) => {
    const result: (AriaNode | string)[] = [];
    for (const child of node.children || []) {
      if (typeof child === 'string') {
        result.push(child);
        continue;
      }
      const normalized = normalizeChildren(child);
      result.push(...normalized);
    }

    // Only remove generic that encloses one element, logical grouping still makes sense, even if it is not ref-able.
    const removeSelf = node.role === 'generic' && result.length <= 1 && result.every(c => typeof c !== 'string' && receivesPointerEvents(c));
    if (removeSelf)
      return result;
    node.children = result;
    return [node];
  };

  normalizeChildren(node);
}

function normalizeStringChildren(rootA11yNode: AriaNode) {
  const flushChildren = (buffer: string[], normalizedChildren: (AriaNode | string)[]) => {
    if (!buffer.length)
      return;
    const text = normalizeWhiteSpace(buffer.join(''));
    if (text)
      normalizedChildren.push(text);
    buffer.length = 0;
  };

  const visit = (ariaNode: AriaNode) => {
    const normalizedChildren: (AriaNode | string)[] = [];
    const buffer: string[] = [];
    for (const child of ariaNode.children || []) {
      if (typeof child === 'string') {
        buffer.push(child);
      } else {
        flushChildren(buffer, normalizedChildren);
        visit(child);
        normalizedChildren.push(child);
      }
    }
    flushChildren(buffer, normalizedChildren);
    ariaNode.children = normalizedChildren.length ? normalizedChildren : [];
    if (ariaNode.children.length === 1 && ariaNode.children[0] === ariaNode.name)
      ariaNode.children = [];
  };
  visit(rootA11yNode);
}

function matchesText(text: string, template: AriaRegex | string | undefined): boolean {
  if (!template)
    return true;
  if (!text)
    return false;
  if (typeof template === 'string')
    return text === template;
  return !!text.match(new RegExp(template.pattern));
}

function matchesTextNode(text: string, template: AriaTemplateTextNode) {
  return matchesText(text, template.text);
}

function matchesName(text: string, template: AriaTemplateRoleNode) {
  return matchesText(text, template.name);
}

export type MatcherReceived = {
  raw: string;
  regex: string;
  diffTarget?: string;
};

export function matchesAriaTree(rootElement: Element, template: AriaTemplateNode): { matches: AriaNode[], received: MatcherReceived } {
  const snapshot = generateAriaTree(rootElement);
  const matches = matchesNodeDeep(snapshot.root, template, false, false);

  // If no matches found, find the best matching subtree for better diff
  let diffTarget: string | undefined;
  if (matches.length === 0) {
    const bestMatch = findBestStructuralMatch(snapshot.root, template);
    if (bestMatch) {
      let root = bestMatch;
      // Wrap fragments in a fake fragment node to prevent rendering parent YAML unnecessarily
      if (template.kind === 'role' && template.role === 'fragment') {
        const bestSubsequence = findBestSubsequence(bestMatch.children, template.children ?? []);
        root = {
          role: 'fragment',
          name: '',
          children: bestSubsequence,
          element: bestMatch.element,
          box: bestMatch.box,
          receivesPointerEvents: bestMatch.receivesPointerEvents,
          props: {}
        };
      }

      diffTarget = renderAriaTree({ root, elements: new Map() }, { mode: 'raw' });
    }
  }

  return {
    matches,
    received: {
      raw: renderAriaTree(snapshot, { mode: 'raw' }),
      regex: renderAriaTree(snapshot, { mode: 'regex' }),
      diffTarget,
    }
  };
}

export function getAllByAria(rootElement: Element, template: AriaTemplateNode): Element[] {
  const root = generateAriaTree(rootElement).root;
  const matches = matchesNodeDeep(root, template, true, false);
  return matches.map(n => n.element);
}

function matchesNode(node: AriaNode | string, template: AriaTemplateNode, isDeepEqual: boolean): boolean {
  if (typeof node === 'string' && template.kind === 'text')
    return matchesTextNode(node, template);

  if (node === null || typeof node !== 'object' || template.kind !== 'role')
    return false;

  if (template.role !== 'fragment' && template.role !== node.role)
    return false;
  if (!matchNodeFields(node, template, true).isMatch)
    return false;
  if (!matchesName(node.name, template))
    return false;
  if (!matchesText(node.props.url, template.props?.url))
    return false;

  // Proceed based on the container mode.
  if (template.containerMode === 'contain')
    return containsList(node.children || [], template.children || []);
  if (template.containerMode === 'equal')
    return listEqual(node.children || [], template.children || [], false);
  if (template.containerMode === 'deep-equal' || isDeepEqual)
    return listEqual(node.children || [], template.children || [], true);
  return containsList(node.children || [], template.children || []);
}

function matchNodeFields(node: AriaNode, template: AriaTemplateRoleNode, fastFail: boolean): { isMatch: boolean, score: number } {
  const fields: Array<keyof AriaProps> = ['checked', 'disabled', 'expanded', 'level', 'pressed', 'selected'];

  let score = 0;
  let isMatch = true;

  for (const field of fields) {
    if (template[field] !== undefined) {
      if (node[field] !== template[field]) {
        if (fastFail)
          return { isMatch: false, score };
        isMatch = false;
      } else {
        score += FIELD_MATCH_SCORE;
      }
    }
  }

  return { isMatch, score };
}

function listEqual(children: (AriaNode | string)[], template: AriaTemplateNode[], isDeepEqual: boolean): boolean {
  if (template.length !== children.length)
    return false;
  for (let i = 0; i < template.length; ++i) {
    if (!matchesNode(children[i], template[i], isDeepEqual))
      return false;
  }
  return true;
}

function containsList(children: (AriaNode | string)[], template: AriaTemplateNode[]): boolean {
  if (template.length > children.length)
    return false;
  const cc = children.slice();
  const tt = template.slice();
  for (const t of tt) {
    let c = cc.shift();
    while (c) {
      if (matchesNode(c, t, false))
        break;
      c = cc.shift();
    }
    if (!c)
      return false;
  }
  return true;
}
function scoreStringSimilarity(actual: string, expected: string): number {
  if (!actual || !expected)
    return 0;
  const commonLength = longestCommonSubstring(actual, expected).length;
  const maxLength = Math.max(actual.length, expected.length);
  return maxLength > 0 ? Math.floor((commonLength / maxLength) * STRING_SIMILARITY_MAX_SCORE) : NO_MATCH_SCORE;
}

function scoreNodeMatch(node: AriaNode | string, template: AriaTemplateNode): number {
  if (typeof node === 'string' && template.kind === 'text') {
    if (matchesTextNode(node, template))
      return EXACT_MATCH_SCORE;
    return typeof template.text === 'string' ? scoreStringSimilarity(node, template.text) : NO_MATCH_SCORE;
  }

  if (typeof node !== 'object' || !node || template.kind !== 'role')
    return NO_MATCH_SCORE;

  let score = 0;
  if (node.role === template.role)
    score += ROLE_MATCH_SCORE;

  if (template.name) {
    if (matchesName(node.name, template))
      score += STRING_SIMILARITY_MAX_SCORE;
    else if (typeof template.name === 'string')
      score += scoreStringSimilarity(node.name, template.name);
  }

  const fieldsMatch = matchNodeFields(node, template, false);
  score += fieldsMatch.score + (fieldsMatch.isMatch ? ALL_FIELDS_MATCH_SCORE : 0);

  if (matchesText(node.props.url, template.props?.url))
    score += FIELD_MATCH_SCORE;
  score += scoreChildrenMatch(node.children || [], template.children || []);

  return score;
}

function findBestChildrenMatches(children: (AriaNode | string)[], templateChildren: AriaTemplateNode[], includePositionBonus: boolean): { score: number, matchIndexes: number[] } {
  if (templateChildren.length === 0)
    return { score: 0, matchIndexes: [] };
  if (children.length === 0)
    return { score: templateChildren.length * NO_CHILDREN_PENALTY, matchIndexes: [] };

  const usedChildrenIndexes = new Set<number>();
  let totalScore = 0;
  let matchedCount = 0;
  const matchIndexes: number[] = [];

  for (let j = 0; j < templateChildren.length; j++) {
    let bestScore = -Infinity;
    let bestIndex = -1;

    for (let i = 0; i < children.length; i++) {
      if (usedChildrenIndexes.has(i))
        continue;

      const nodeScore = scoreNodeMatch(children[i], templateChildren[j]);
      const positionBonus = includePositionBonus && i === j ? INDEX_MATCH_BONUS_SCORE : 0;
      const score = nodeScore + positionBonus;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore > 0) {
      usedChildrenIndexes.add(bestIndex);
      totalScore += bestScore;
      matchedCount++;
      matchIndexes.push(bestIndex);
    } else if (includePositionBonus) {
      // The next template node sequentially is a poor match for the actual node
      totalScore -= INDEX_MISMATCH_PENALTY;
    }
  }

  if (includePositionBonus && matchedCount === templateChildren.length)
    totalScore += COUNT_MATCH_SCORE;

  return { score: totalScore, matchIndexes };
}

function scoreChildrenMatch(children: (AriaNode | string)[], templateChildren: AriaTemplateNode[]): number {
  return findBestChildrenMatches(children, templateChildren, true).score;
}

function findBestSubsequence(children: (AriaNode | string)[], templateChildren: AriaTemplateNode[]): (AriaNode | string)[] {
  if (templateChildren.length === 0 || children.length === 0)
    return [];
  const result = findBestChildrenMatches(children, templateChildren, false);
  // Preserve the order of children
  return result.matchIndexes.sort((a, b) => a - b).map(i => children[i]);
}

function findBestStructuralMatch(root: AriaNode, template: AriaTemplateNode): AriaNode | undefined {
  let bestMatch: AriaNode | undefined = undefined;
  let bestScore = -Infinity;

  function traverse(node: AriaNode, depth: number): void {
    let baseScore: number;
    if (template.kind === 'role' && template.role === 'fragment' && template.children && template.children.length > 1)
      baseScore = scoreChildrenMatch(node.children || [], template.children);
    else
      baseScore = scoreNodeMatch(node, template);

    // Slightly prefer deeper matches
    const score = baseScore + (depth * DEPTH_BONUS_SCORE);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = node;
    }

    for (const child of node.children) {
      if (typeof child !== 'string')
        traverse(child, depth + 1);
    }
  }

  traverse(root, 0);
  return bestMatch;
}

function matchesNodeDeep(root: AriaNode, template: AriaTemplateNode, collectAll: boolean, isDeepEqual: boolean): AriaNode[] {
  const results: AriaNode[] = [];
  const visit = (node: AriaNode | string, parent: AriaNode | null): boolean => {
    if (matchesNode(node, template, isDeepEqual)) {
      const result = typeof node === 'string' ? parent : node;
      if (result)
        results.push(result);
      return !collectAll;
    }
    if (typeof node === 'string')
      return false;
    for (const child of node.children || []) {
      if (visit(child, node))
        return true;
    }
    return false;
  };
  visit(root, null);
  return results;
}

export function renderAriaTree(ariaSnapshot: AriaSnapshot, options?: { mode?: 'raw' | 'regex', forAI?: boolean }): string {
  const lines: string[] = [];
  const includeText = options?.mode === 'regex' ? textContributesInfo : () => true;
  const renderString = options?.mode === 'regex' ? convertToBestGuessRegex : (str: string) => str;
  const visit = (ariaNode: AriaNode | string, parentAriaNode: AriaNode | null, indent: string) => {
    if (typeof ariaNode === 'string') {
      if (parentAriaNode && !includeText(parentAriaNode, ariaNode))
        return;
      const text = yamlEscapeValueIfNeeded(renderString(ariaNode));
      if (text)
        lines.push(indent + '- text: ' + text);
      return;
    }

    let key = ariaNode.role;
    // Yaml has a limit of 1024 characters per key, and we leave some space for role and attributes.
    if (ariaNode.name && ariaNode.name.length <= 900) {
      const name = renderString(ariaNode.name);
      if (name) {
        const stringifiedName = name.startsWith('/') && name.endsWith('/') ? name : JSON.stringify(name);
        key += ' ' + stringifiedName;
      }
    }
    if (ariaNode.checked === 'mixed')
      key += ` [checked=mixed]`;
    if (ariaNode.checked === true)
      key += ` [checked]`;
    if (ariaNode.disabled)
      key += ` [disabled]`;
    if (ariaNode.expanded)
      key += ` [expanded]`;
    if (ariaNode.level)
      key += ` [level=${ariaNode.level}]`;
    if (ariaNode.pressed === 'mixed')
      key += ` [pressed=mixed]`;
    if (ariaNode.pressed === true)
      key += ` [pressed]`;
    if (ariaNode.selected === true)
      key += ` [selected]`;
    if (options?.forAI && receivesPointerEvents(ariaNode)) {
      const ref = ariaNode.ref;
      const cursor = hasPointerCursor(ariaNode) ? ' [cursor=pointer]' : '';
      if (ref)
        key += ` [ref=${ref}]${cursor}`;
    }

    const escapedKey = indent + '- ' + yamlEscapeKeyIfNeeded(key);
    const hasProps = !!Object.keys(ariaNode.props).length;
    if (!ariaNode.children.length && !hasProps) {
      lines.push(escapedKey);
    } else if (ariaNode.children.length === 1 && typeof ariaNode.children[0] === 'string' && !hasProps) {
      const text = includeText(ariaNode, ariaNode.children[0]) ? renderString(ariaNode.children[0] as string) : null;
      if (text)
        lines.push(escapedKey + ': ' + yamlEscapeValueIfNeeded(text));
      else
        lines.push(escapedKey);
    } else {
      lines.push(escapedKey + ':');
      for (const [name, value] of Object.entries(ariaNode.props))
        lines.push(indent + '  - /' + name + ': ' + yamlEscapeValueIfNeeded(value));
      for (const child of ariaNode.children || [])
        visit(child, ariaNode, indent + '  ');
    }
  };

  const ariaNode = ariaSnapshot.root;
  if (ariaNode.role === 'fragment') {
    // Render fragment.
    for (const child of ariaNode.children || [])
      visit(child, ariaNode, '');
  } else {
    visit(ariaNode, null, '');
  }
  return lines.join('\n');
}

function convertToBestGuessRegex(text: string): string {
  const dynamicContent = [
    // 2mb
    { regex: /\b[\d,.]+[bkmBKM]+\b/, replacement: '[\\d,.]+[bkmBKM]+' },
    // 2ms, 20s
    { regex: /\b\d+[hmsp]+\b/, replacement: '\\d+[hmsp]+' },
    { regex: /\b[\d,.]+[hmsp]+\b/, replacement: '[\\d,.]+[hmsp]+' },
    // Do not replace single digits with regex by default.
    // 2+ digits: [Issue 22, 22.3, 2.33, 2,333]
    { regex: /\b\d+,\d+\b/, replacement: '\\d+,\\d+' },
    { regex: /\b\d+\.\d{2,}\b/, replacement: '\\d+\\.\\d+' },
    { regex: /\b\d{2,}\.\d+\b/, replacement: '\\d+\\.\\d+' },
    { regex: /\b\d{2,}\b/, replacement: '\\d+' },
  ];

  let pattern = '';
  let lastIndex = 0;

  const combinedRegex = new RegExp(dynamicContent.map(r => '(' + r.regex.source + ')').join('|'), 'g');
  text.replace(combinedRegex, (match, ...args) => {
    const offset = args[args.length - 2];
    const groups = args.slice(0, -2);
    pattern += escapeRegExp(text.slice(lastIndex, offset));
    for (let i = 0; i < groups.length; i++) {
      if (groups[i]) {
        const { replacement } = dynamicContent[i];
        pattern += replacement;
        break;
      }
    }
    lastIndex = offset + match.length;
    return match;
  });
  if (!pattern)
    return text;

  pattern += escapeRegExp(text.slice(lastIndex));
  return String(new RegExp(pattern));
}

function textContributesInfo(node: AriaNode, text: string): boolean {
  if (!text.length)
    return false;

  if (!node.name)
    return true;

  if (node.name.length > text.length)
    return false;

  // Figure out if text adds any value. "longestCommonSubstring" is expensive, so limit strings length.
  const substr = (text.length <= 200 && node.name.length <= 200) ? longestCommonSubstring(text, node.name) : '';
  let filtered = text;
  while (substr && filtered.includes(substr))
    filtered = filtered.replace(substr, '');
  return filtered.trim().length / text.length > 0.1;
}

function receivesPointerEvents(ariaNode: AriaNode): boolean {
  return ariaNode.box.visible && ariaNode.receivesPointerEvents;
}

function hasPointerCursor(ariaNode: AriaNode): boolean {
  return ariaNode.box.style?.cursor === 'pointer';
}
