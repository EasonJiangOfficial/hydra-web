"use client";

import "@blocknote/shadcn/style.css";
import "./block-editor.css";

import {
  BlockNoteSchema,
  createHeadingBlockSpec,
  defaultBlockSpecs,
  defaultStyleSpecs,
  filterSuggestionItems,
  type BlockNoteEditor,
  type PartialBlock,
} from "@blocknote/core";
import { en } from "@blocknote/core/locales";
import {
  BasicTextStyleButton,
  BlockTypeSelect,
  CreateLinkButton,
  DragHandleMenu,
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
  type FloatingUIOptions,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useEffect } from "react";

import type { NoteDoc } from "@/lib/notes/doc";

/**
 * The Notes editor: BlockNote (slash menu, drag handles, markdown shortcuts, paste from the web) on Hydra's
 * tokens. Blocks: text, headings 1 to 3, bulleted, numbered, to-do and toggle lists, quote, code, divider,
 * table. No files (no upload store) and no colors: the text and background color styles are left out of
 * the schema, and the drag menu keeps only Delete. The formatting toolbar keeps the block type, the four
 * text styles and the link; the slash menu shows titles only. Every block type and style here is in
 * BLOCK_TYPES and STYLES (src/lib/notes/doc.ts), which the server holds a saved document to.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- left out on purpose: no files, no colors
const { audio, file, image, video, heading, ...blocks } = defaultBlockSpecs;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { textColor, backgroundColor, ...styles } = defaultStyleSpecs;

const schema = BlockNoteSchema.create({
  blockSpecs: { ...blocks, heading: createHeadingBlockSpec({ levels: [1, 2, 3] }) },
  styleSpecs: styles,
});

type S = typeof schema;
export type NotesEditor = BlockNoteEditor<S["blockSchema"], S["inlineContentSchema"], S["styleSchema"]>;

/** Left out of the slash menu: toggle headings (a toggle list does it) and emoji. */
const notInSlash = new Set([en.slash_menu.toggle_heading.title, en.slash_menu.toggle_heading_2.title, en.slash_menu.toggle_heading_3.title, en.slash_menu.emoji.title]);

/** The slash menu: each block a title and its icon (no subtext, groups or shortcut chips). */
const slashItems = (editor: NotesEditor) =>
  getDefaultReactSlashMenuItems(editor)
    .filter((i) => !notInSlash.has(i.title))
    .map((i) => ({ ...i, subtext: undefined, badge: undefined, group: undefined, size: "small" as const }));

/** No helper sentence on an empty line; the short block names (Heading, List) stay. */
const dictionary = { ...en, placeholders: { ...en.placeholders, default: "", emptyDocument: undefined } };

/** The deepest heading the schema holds: a pasted h4 to h6 becomes one. */
const HEADING_MAX = 3;

type Middleware = NonNullable<NonNullable<FloatingUIOptions["useFloatingOptions"]>["middleware"]>[number];

/**
 * Where the formatting toolbar sits: 10 px above the selection (below it when there is no room), and
 * never within 16 px of the window's sides. It stands in for BlockNote's offset, flip and shift, whose
 * shift lets the toolbar touch the edge.
 */
const toolbarPlace: Middleware = {
  name: "hyToolbarPlace",
  fn: ({ x, rects, elements }) => {
    const pad = 16;
    const gap = 10;
    const ref = elements.reference.getBoundingClientRect();
    // From the popover's coordinates to the window's, and back.
    const dx = ref.left - rects.reference.x;
    const dy = ref.top - rects.reference.y;
    const { width, height } = rects.floating;
    const left = Math.max(pad, Math.min(x + dx, window.innerWidth - width - pad));
    const above = ref.top - gap - height;
    const top = above >= pad ? above : ref.bottom + gap;
    return { x: left - dx, y: top - dy };
  },
};
const toolbarOptions: FloatingUIOptions = { useFloatingOptions: { middleware: [toolbarPlace] } };

function Toolbar() {
  return (
    <FormattingToolbar>
      <BlockTypeSelect key="blockTypeSelect" />
      <BasicTextStyleButton basicTextStyle="bold" key="bold" />
      <BasicTextStyleButton basicTextStyle="italic" key="italic" />
      <BasicTextStyleButton basicTextStyle="underline" key="underline" />
      <BasicTextStyleButton basicTextStyle="strike" key="strike" />
      <CreateLinkButton key="link" />
    </FormattingToolbar>
  );
}

function DeleteOnlyMenu() {
  return (
    <DragHandleMenu>
      <RemoveBlockItem>Delete</RemoveBlockItem>
    </DragHandleMenu>
  );
}

export default function BlockEditor({
  initial,
  onChange,
  onReady,
}: {
  initial: NoteDoc;
  onChange: (doc: NoteDoc) => void;
  onReady?: (editor: NotesEditor) => void;
}) {
  const editor = useCreateBlockNote({
    schema,
    initialContent: initial.length ? (initial as PartialBlock<S["blockSchema"], S["inlineContentSchema"], S["styleSchema"]>[]) : undefined,
    dictionary,
  });
  useEffect(() => onReady?.(editor), [editor, onReady]);
  return (
    <BlockNoteView
      editor={editor}
      theme="light"
      sideMenu={false}
      formattingToolbar={false}
      slashMenu={false}
      className="hy-notes-editor"
      data-testid="note-editor"
      onChange={() => {
        // Paste keeps h4 to h6 as their level, which the schema leaves out: make them level 3 (this fires
        // onChange again, with the document to save). Out of the undo history, so one undo takes the paste
        // away instead of bringing the deep level back.
        const deep: string[] = [];
        editor.forEachBlock((b) => {
          if (b.type === "heading" && Number(b.props.level) > HEADING_MAX) deep.push(b.id);
          return true;
        });
        if (deep.length) {
          editor.transact((tr) => {
            tr.setMeta("addToHistory", false);
            deep.forEach((id) => editor.updateBlock(id, { props: { level: HEADING_MAX } }));
          });
          return;
        }
        onChange(editor.document as unknown as NoteDoc);
      }}
    >
      <SideMenuController sideMenu={(props) => <SideMenu {...props} dragHandleMenu={DeleteOnlyMenu} />} />
      <FormattingToolbarController formattingToolbar={Toolbar} floatingUIOptions={toolbarOptions} />
      <SuggestionMenuController triggerCharacter="/" getItems={async (query) => filterSuggestionItems(slashItems(editor), query)} />
    </BlockNoteView>
  );
}
