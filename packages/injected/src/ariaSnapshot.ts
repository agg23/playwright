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

export interface MatchFailure {
  templateLineNumber?: number;
  isFromTemplateRegex?: boolean; // True if this failure was due to a regex in the template name/prop
}

type AriaRef = {
  role: string;
  name: string;
  ref: string;
};

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

function matchesText(text: string, template: AriaRegex | string | undefined): {
  match: boolean;
  isFromTemplateRegex: boolean;
} {
  if (!template)
    return { match: true, isFromTemplateRegex: false };
  if (!text)
    return { match: false, isFromTemplateRegex: false };
  if (typeof template === 'string')
    return { match: text === template, isFromTemplateRegex: false };
  return { match: !!text.match(new RegExp(template.pattern)), isFromTemplateRegex: true };
}

function matchesTextNode(text: string, template: AriaTemplateTextNode): MatchFailure[] {
  if (matchesText(text, template.text).match)
    return [];
  return [{ templateLineNumber: template.lineNumber }];
}

function matchesName(text: string, template: AriaTemplateRoleNode) {
  return matchesText(text, template.name);
}

export type MatcherReceived = {
  raw: string;
  regex: string;
};

export function matchesAriaTree(rootElement: Element, template: AriaTemplateNode): { matches: AriaNode[], failures: MatchFailure[], received: MatcherReceived } {
  const snapshot = generateAriaTree(rootElement);
  // 'isDeepEqual' for the root comparison itself. Children comparison is driven by template.containerMode.
  // const failures = matchesNode(snapshot.root, template, false);
  const { matches, failures } = matchesNodeDeep(snapshot.root, template, false, false);

  // let matches: AriaNode[] = [];
  // if (failures.length === 0) {
  //   // If there are no mismatches for the whole tree starting from the root,
  //   // then snapshot.root itself is considered the match.
  //   matches = [snapshot.root];
  // }
  // If mismatches.length > 0, the overall structure doesn't match, so 'matches' remains empty.

  return {
    matches,
    failures,
    received: {
      raw: renderAriaTree(snapshot, { mode: 'raw' }),
      regex: renderAriaTree(snapshot, { mode: 'regex' }),
    }
  };
}

export function getAllByAria(rootElement: Element, template: AriaTemplateNode): Element[] {
  const root = generateAriaTree(rootElement).root;
  const matches = matchesNodeDeep(root, template, true, false);
  return matches.map(n => n.element);
}

function matchesNode(node: AriaNode | string, template: AriaTemplateNode, isDeepEqual: boolean): MatchFailure[] {
  console.log('matchesNode', node, template);
  if (typeof node === 'string' && template.kind === 'text')
    return matchesTextNode(node, template).map(f => ({ ...f, isFromTemplateRegex: false }));

  if (node === null || typeof node !== 'object' || template.kind !== 'role')
    return [{ templateLineNumber: template.lineNumber, isFromTemplateRegex: false }];

  const otherDirectFailures: MatchFailure[] = [];
  if (template.role !== 'fragment' && template.role !== node.role)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
  if (template.checked !== undefined && template.checked !== node.checked)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
  if (template.disabled !== undefined && template.disabled !== node.disabled)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
  if (template.expanded !== undefined && template.expanded !== node.expanded)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
  if (template.level !== undefined && template.level !== node.level)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
  if (template.pressed !== undefined && template.pressed !== node.pressed)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
  if (template.selected !== undefined && template.selected !== node.selected)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
  const doesMatchName = matchesName(node.name, template);
  if (!doesMatchName.match)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: doesMatchName.isFromTemplateRegex });
  const doesMatchUrl = matchesText(node.props.url, template.props?.url);
  if (!doesMatchUrl.match)
    otherDirectFailures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: doesMatchUrl.isFromTemplateRegex });

  if (template.containerMode === 'contain')
    return containsList(node.children || [], template.children || []);
  if (template.containerMode === 'equal')
    return listEqual(node.children || [], template.children || [], false);
  if (template.containerMode === 'deep-equal' || isDeepEqual)
    return listEqual(node.children || [], template.children || [], true);
  return containsList(node.children || [], template.children || []);
  // const actualChildren = node.children || [];
  // const templateChildren = template.children || [];
  // // Child comparison logic: default to listEqual for this prioritized approach.
  // // The containerMode would need careful integration if it's to override this prioritization.
  // const useDeepEqualForChildren = template.containerMode === 'deep-equal' || isChildrenDeepEqual;
  // // listEqual calls this matchesNode, so isFromTemplateRegex will propagate up.
  // const childComparisonFailures = listEqual(actualChildren, templateChildren, useDeepEqualForChildren);

  // // Prioritization Logic:
  // // 1. If any child returned a failure marked as 'isFromTemplateRegex', that's the single most important failure.
  // const primaryChildRegexFailure = childComparisonFailures.find(f => f.isFromTemplateRegex);
  // if (primaryChildRegexFailure)
  //   return [primaryChildRegexFailure];

  // // 2. If no regex failures from children, but other (non-regex) child failures exist, return the first of those.
  // if (childComparisonFailures.length > 0) {
  //   // Ensure the returned failure has isFromTemplateRegex (should be false if not set by a deeper regex)
  //   const firstChildFailure = childComparisonFailures[0];
  //   return [{ ...firstChildFailure, isFromTemplateRegex: firstChildFailure.isFromTemplateRegex || false }];
  // }

  // // 3. If no child failures at all, return the first direct failure of this node (which are non-regex by this point).
  // if (otherDirectFailures.length > 0) {
  //   // All otherDirectFailures are already marked with isFromTemplateRegex: false.
  //   return [otherDirectFailures[0]];
  // }

  // return []; // Perfect match for this node and its subtree.
}

// function listEqual(actualChildren: (AriaNode | string)[], templateChildren: AriaTemplateNode[], areChildrenDeepEqual: boolean): MatchFailure[] {
//   const len = Math.min(actualChildren.length, templateChildren.length);

//   for (let i = 0; i < len; ++i) {
//     const itemMismatches = matchesNode(actualChildren[i], templateChildren[i], areChildrenDeepEqual);
//     const primaryRegexFailureInChild = itemMismatches.find(f => f.isFromTemplateRegex);
//     if (primaryRegexFailureInChild)
//       return [primaryRegexFailureInChild]; // This regex failure takes precedence.
//     if (itemMismatches.length > 0) {
//       // If no regex failure, but other mismatches, return the first of those.
//       // Ensure isFromTemplateRegex is consistently set (should be false here).
//       const firstMismatch = itemMismatches[0];
//       return [{ ...firstMismatch, isFromTemplateRegex: false }];
//     }
//   }

//   // If common part matched perfectly, check for length differences.
//   if (templateChildren.length > actualChildren.length) // Template expected more children
//     return [{ templateLineNumber: templateChildren[len].lineNumber, isFromTemplateRegex: false }];
//   if (actualChildren.length > templateChildren.length) { // Actual has extra children
//     // If template had items, blame the last one for "extras after this".
//     // If template was empty, this implies a mismatch for the parent node (expecting no children).
//     // matchesNode should handle this by returning its own line if its otherDirectFailures was empty.
//     // For listEqual to contribute a failure here, associate with last template line if possible.
//     if (templateChildren.length > 0)
//       return [{ templateLineNumber: templateChildren[templateChildren.length - 1].lineNumber, isFromTemplateRegex: false }];
//     // If templateChildren was empty and actualChildren is not, listEqual returns []
//     // allowing matchesNode to decide if the parent node itself is the failure.
//   }

//   return []; // Perfect match for this list segment.
// }

// function listEqual(children: (AriaNode | string)[], template: AriaTemplateNode[], isDeepEqual: boolean): boolean {
//   if (template.length !== children.length)
//     return false;
//   for (let i = 0; i < template.length; ++i) {
//     if (!matchesNode(children[i], template[i], isDeepEqual))
//       return false;
//   }
//   return true;
// }

function listEqual(children: (AriaNode | string)[], template: AriaTemplateNode[], isDeepEqual: boolean): MatchFailure[] {
  const length = Math.min(children.length, template.length);

  const failures: MatchFailure[] = [];

  for (let i = 0; i < length; ++i)
    failures.push(...matchesNode(children[i], template[i], isDeepEqual));
  for (let i = length; i < template.length; ++i) {
    // Mark any extra template items as mismatches
    failures.push({ templateLineNumber: template[i].lineNumber, isFromTemplateRegex: false });
  }

  return failures;
}

// TODO: Finish
function containsList(children: (AriaNode | string)[], template: AriaTemplateNode[]): MatchFailure[] {
  console.log('containsList', children, template);
  if (template.length > children.length) {
    console.log('Template is longer than children', template, children);
    return [{ templateLineNumber: template[children.length].lineNumber, isFromTemplateRegex: false }];
  }
  const cc = children.slice();
  const tt = template.slice();
  const allFailures: MatchFailure[] = [];
  for (const t of tt) {
    let c = cc.shift();
    const localFailures: MatchFailure[] = [];
    while (c) {
      const failures = matchesNode(c, t, false);
      if (failures.length === 0)
        break;
      c = cc.shift();
      // TODO: This isn't right
      localFailures.push(...failures);
      console.log('localFailures', localFailures);
    }
    if (!c) {
      // allFailures.push(...localFailures, { templateLineNumber: t.lineNumber, isFromTemplateRegex: false });
      // console.log('Local error', t.lineNumber);
      return [...localFailures, { templateLineNumber: t.lineNumber, isFromTemplateRegex: false }];
    }
  }
  console.log('allFailures', allFailures);
  return [];
}

// function containsList(children: (AriaNode | string)[], template: AriaTemplateNode[]): MatchFailure[] {
//   // if (template.length > children.length)
//   //   return [{ templateLineNumber: 1, isFromTemplateRegex: false }];
//   const cc = children.slice();
//   const tt = template.slice();
//   for (const t of tt) {
//     let c = cc.shift();
//     while (c) {
//       if (matchesNode(c, t, false).length === 0)
//         break;
//       c = cc.shift();
//     }
//     if (!c)
//       return [{ templateLineNumber: t.lineNumber, isFromTemplateRegex: false }];
//   }
//   return [];
// }

function matchesNodeDeep(root: AriaNode, template: AriaTemplateNode, collectAll: boolean, isDeepEqual: boolean): { matches: AriaNode[], failures: MatchFailure[] } {
  const results: AriaNode[] = [];
  const failures: MatchFailure[] = [];
  const visit = (node: AriaNode | string, parent: AriaNode | null): boolean => {
    const localFailures = matchesNode(node, template, isDeepEqual);
    if (localFailures.length === 0) {
      const result = typeof node === 'string' ? parent : node;
      if (result)
        results.push(result);
      return !collectAll;
    }
    failures.push(...localFailures);
    if (typeof node === 'string') {
      failures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
      return false;
    }
    for (const child of node.children || []) {
      if (visit(child, node))
        return true;
    }
    failures.push({ templateLineNumber: template.lineNumber, isFromTemplateRegex: false });
    return false;
  };
  visit(root, null);
  return { matches: results, failures };
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
