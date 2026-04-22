import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

export interface EditorThemeTokens {
  key: string // propertyName (e.g. JSON keys)
  string: string
  number: string
  bool: string
  null: string
}

export interface EditorThemeDef {
  name: string
  dark: boolean
  background: string
  foreground: string
  accent: string // representative color for preview (e.g. function name color)
  tokens: EditorThemeTokens
  extension: Extension
}

const oneDarkDef: EditorThemeDef = {
  name: 'One Dark',
  dark: true,
  background: '#282c34',
  foreground: '#abb2bf',
  accent: '#98c379',
  tokens: { key: '#e06c75', string: '#98c379', number: '#d19a66', bool: '#d19a66', null: '#d19a66' },
  extension: oneDark,
}

function makeTheme(
  bg: string,
  fg: string,
  gutterBg: string,
  gutterFg: string,
  selection: string,
  activeLine: string,
  dark: boolean,
  highlights: Parameters<typeof HighlightStyle.define>[0],
): Extension {
  return [
    EditorView.theme(
      {
        '&': { backgroundColor: bg, color: fg },
        '.cm-gutters': {
          backgroundColor: gutterBg,
          color: gutterFg,
          borderRight: '1px solid rgba(128,128,128,0.2)',
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: selection },
        '.cm-activeLine': { backgroundColor: activeLine },
        '.cm-activeLineGutter': { backgroundColor: activeLine },
        '.cm-cursor': { borderLeftColor: fg },
      },
      { dark },
    ),
    syntaxHighlighting(HighlightStyle.define(highlights)),
  ]
}

const defaultLight: EditorThemeDef = {
  name: 'Default Light',
  dark: false,
  background: '#ffffff',
  foreground: '#333333',
  accent: '#6f42c1',
  tokens: { key: '#005cc5', string: '#032f62', number: '#005cc5', bool: '#005cc5', null: '#005cc5' },
  extension: makeTheme('#ffffff', '#333333', '#f5f5f5', '#999999', '#d7d4f0', '#f5f5f5', false, [
    { tag: tags.keyword, color: '#d73a49' },
    { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#333333' },
    { tag: [tags.function(tags.variableName), tags.labelName], color: '#6f42c1' },
    { tag: [tags.propertyName], color: '#005cc5' },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#005cc5' },
    { tag: [tags.definition(tags.name), tags.separator], color: '#333333' },
    {
      tag: [tags.typeName, tags.className, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
      color: '#e36209',
    },
    { tag: [tags.number], color: '#005cc5' },
    { tag: [tags.operator, tags.operatorKeyword], color: '#d73a49' },
    { tag: [tags.url, tags.escape, tags.regexp, tags.link], color: '#032f62' },
    { tag: [tags.meta, tags.comment], color: '#6a737d' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, textDecoration: 'underline' },
    { tag: tags.heading, fontWeight: 'bold', color: '#005cc5' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#005cc5' },
    { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#032f62' },
  ]),
}

const dracula: EditorThemeDef = {
  name: 'Dracula',
  dark: true,
  background: '#282a36',
  foreground: '#f8f8f2',
  accent: '#50fa7b',
  tokens: { key: '#66d9ef', string: '#f1fa8c', number: '#bd93f9', bool: '#bd93f9', null: '#bd93f9' },
  extension: makeTheme('#282a36', '#f8f8f2', '#282a36', '#6272a4', '#44475a', '#2c2e3a', true, [
    { tag: tags.keyword, color: '#ff79c6' },
    { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#f8f8f2' },
    { tag: [tags.function(tags.variableName), tags.labelName], color: '#50fa7b' },
    { tag: [tags.propertyName], color: '#66d9ef' },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#bd93f9' },
    {
      tag: [tags.typeName, tags.className, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
      color: '#8be9fd',
    },
    { tag: [tags.number], color: '#bd93f9' },
    { tag: [tags.operator, tags.operatorKeyword], color: '#ff79c6' },
    { tag: [tags.url, tags.escape, tags.regexp, tags.link], color: '#f1fa8c' },
    { tag: [tags.meta, tags.comment], color: '#6272a4' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.heading, fontWeight: 'bold', color: '#bd93f9' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#bd93f9' },
    { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#f1fa8c' },
  ]),
}

const nord: EditorThemeDef = {
  name: 'Nord',
  dark: true,
  background: '#2e3440',
  foreground: '#d8dee9',
  accent: '#88c0d0',
  tokens: { key: '#8fbcbb', string: '#a3be8c', number: '#b48ead', bool: '#b48ead', null: '#b48ead' },
  extension: makeTheme('#2e3440', '#d8dee9', '#2e3440', '#4c566a', '#434c5e', '#353b49', true, [
    { tag: tags.keyword, color: '#81a1c1' },
    { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#d8dee9' },
    { tag: [tags.function(tags.variableName), tags.labelName], color: '#88c0d0' },
    { tag: [tags.propertyName], color: '#8fbcbb' },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#5e81ac' },
    {
      tag: [tags.typeName, tags.className, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
      color: '#8fbcbb',
    },
    { tag: [tags.number], color: '#b48ead' },
    { tag: [tags.operator, tags.operatorKeyword], color: '#81a1c1' },
    { tag: [tags.url, tags.escape, tags.regexp, tags.link], color: '#ebcb8b' },
    { tag: [tags.meta, tags.comment], color: '#616e88' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.heading, fontWeight: 'bold', color: '#88c0d0' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#b48ead' },
    { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#a3be8c' },
  ]),
}

const solarizedLight: EditorThemeDef = {
  name: 'Solarized Light',
  dark: false,
  background: '#fdf6e3',
  foreground: '#657b83',
  accent: '#268bd2',
  tokens: { key: '#268bd2', string: '#2aa198', number: '#d33682', bool: '#d33682', null: '#d33682' },
  extension: makeTheme('#fdf6e3', '#657b83', '#eee8d5', '#93a1a1', '#eee8d5', '#f5efdc', false, [
    { tag: tags.keyword, color: '#859900' },
    { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#657b83' },
    { tag: [tags.function(tags.variableName), tags.labelName], color: '#268bd2' },
    { tag: [tags.propertyName], color: '#268bd2' },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#cb4b16' },
    {
      tag: [tags.typeName, tags.className, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
      color: '#b58900',
    },
    { tag: [tags.number], color: '#d33682' },
    { tag: [tags.operator, tags.operatorKeyword], color: '#859900' },
    { tag: [tags.url, tags.escape, tags.regexp, tags.link], color: '#cb4b16' },
    { tag: [tags.meta, tags.comment], color: '#93a1a1' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.heading, fontWeight: 'bold', color: '#268bd2' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#d33682' },
    { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#2aa198' },
  ]),
}

const monokai: EditorThemeDef = {
  name: 'Monokai',
  dark: true,
  background: '#272822',
  foreground: '#f8f8f2',
  accent: '#a6e22e',
  tokens: { key: '#66d9ef', string: '#e6db74', number: '#ae81ff', bool: '#ae81ff', null: '#ae81ff' },
  extension: makeTheme('#272822', '#f8f8f2', '#272822', '#90908a', '#49483e', '#3e3d32', true, [
    { tag: tags.keyword, color: '#f92672' },
    { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#f8f8f2' },
    { tag: [tags.function(tags.variableName), tags.labelName], color: '#a6e22e' },
    { tag: [tags.propertyName], color: '#66d9ef' },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#ae81ff' },
    {
      tag: [tags.typeName, tags.className, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
      color: '#66d9ef',
      fontStyle: 'italic',
    },
    { tag: [tags.number], color: '#ae81ff' },
    { tag: [tags.operator, tags.operatorKeyword], color: '#f92672' },
    { tag: [tags.url, tags.escape, tags.regexp, tags.link], color: '#e6db74' },
    { tag: [tags.meta, tags.comment], color: '#75715e' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.heading, fontWeight: 'bold', color: '#a6e22e' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#ae81ff' },
    { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#e6db74' },
  ]),
}

export const EDITOR_THEMES: EditorThemeDef[] = [oneDarkDef, defaultLight, dracula, nord, solarizedLight, monokai]

export function getEditorTheme(name: string): EditorThemeDef {
  return EDITOR_THEMES.find((t) => t.name === name) ?? EDITOR_THEMES[0]
}
