import { Extension, type Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import { cn } from "../lib/utils";

/** A table's header row typed as Markdown: `| Name | Value |`. */
const TABLE_ROW = /^\s*\|((?:[^|\n]*\|)+)\s*$/;

/**
 * Tables as you type them: Enter after a header row (`| a | b |`) makes a table with an empty
 * row to fill, Tab moves between cells, and Enter in a table goes to the next row (adding one at
 * the end). Markdown tables have no other way in, short of pasting one.
 */
const TableShortcuts = Extension.create({
  name: "tableShortcuts",
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty) return false;
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name !== "table") continue;
          const table = $from.node(depth);
          const rowIndex = $from.index(depth);
          const lastRow = rowIndex === table.childCount - 1;
          // Enter on an empty last row leaves the table, like an empty list item leaves a list.
          if (lastRow && rowIndex > 1 && !table.child(rowIndex).textContent) {
            return editor
              .chain()
              .deleteRow()
              .command(({ tr }) => {
                const after = tr.mapping.map($from.after(depth));
                if (tr.doc.nodeAt(after)?.type.name !== "paragraph") tr.insert(after, editor.schema.nodes.paragraph.create());
                tr.setSelection(TextSelection.create(tr.doc, after + 1));
                return true;
              })
              .run();
          }
          if (lastRow) editor.commands.addRowAfter();
          const next = editor.state.doc.nodeAt($from.before(depth));
          if (!next) return true;
          let pos = $from.before(depth) + 1;
          for (let i = 0; i <= rowIndex; i++) pos += next.child(i).nodeSize;
          // Into the next row, its first cell and that cell's paragraph.
          const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 3));
          editor.view.dispatch(tr.scrollIntoView());
          return true;
        }

        const paragraph = $from.parent;
        const match = paragraph.type.name === "paragraph" && $from.parentOffset === paragraph.content.size && paragraph.textContent.match(TABLE_ROW);
        if (!match) return false;
        const cells = match[1].split("|").slice(0, -1).map((cell) => cell.trim());
        const cell = (type: string, text: string) => ({
          type,
          content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
        });
        const from = $from.before();
        editor
          .chain()
          .insertContentAt(
            { from, to: $from.after() },
            {
              type: "table",
              content: [
                { type: "tableRow", content: cells.map((text) => cell("tableHeader", text)) },
                { type: "tableRow", content: cells.map(() => cell("tableCell", "")) },
              ],
            },
          )
          .command(({ tr }) => {
            const table = tr.doc.nodeAt(from);
            if (!table) return false;
            // Into the table, past the header row, then into the first cell's paragraph.
            tr.setSelection(TextSelection.create(tr.doc, from + 1 + table.child(0).nodeSize + 3));
            return true;
          })
          .run();
        return true;
      },
    };
  },
});

/**
 * Pastes Markdown text as what it means, so a pasted list or table arrives formatted. Code
 * copied from an editor (VS Code, Cursor) becomes a code block; inside a code block, text stays
 * text, and rich content (from a web page or this editor) pastes as it is.
 */
function pasteText(editor: Editor, data: DataTransfer): boolean {
  const text = data.getData("text/plain");
  if (!text || editor.isActive("codeBlock")) return false;
  const vscode = data.getData("vscode-editor-data");
  if (vscode && text.includes("\n")) {
    let language: string | null = null;
    try {
      language = JSON.parse(vscode).mode ?? null;
    } catch {}
    return editor
      .chain()
      .insertContent({ type: "codeBlock", attrs: { language }, content: [{ type: "text", text: text.replace(/\n$/, "") }] })
      .run();
  }
  if (data.types.includes("text/html") || !editor.markdown) return false;
  const blocks = editor.markdown.parse(text).content ?? [];
  // A line of text joins the paragraph it's pasted into rather than starting its own.
  const only = blocks.length === 1 && blocks[0].type === "paragraph" ? blocks[0] : null;
  return editor.commands.insertContent(only ? (only.content ?? []) : blocks);
}

/**
 * A comment field that writes Markdown but shows it rendered as you type, like GitHub's or
 * Linear's editors: `code`, **bold**, "- " lists, ``` code blocks, "> " quotes and `| a | b |`
 * tables turn into what they mean. `value` and `onChange` are the Markdown text.
 */
export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  onPasteFiles,
  placeholder,
  autoFocus,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** ⌘↩. */
  onSubmit: () => void;
  /** Esc. */
  onCancel: () => void;
  /** Takes a paste with files (screenshots) instead of the editor; true if it did. */
  onPasteFiles: (data: DataTransfer) => boolean;
  placeholder: string;
  autoFocus?: boolean;
  className?: string;
}) {
  // The editor is created once; its handlers read the latest props.
  const props = useRef({ onChange, onSubmit, onCancel, onPasteFiles });
  props.current = { onChange, onSubmit, onCancel, onPasteFiles };
  // The Markdown last emitted, so the editor's own normalisation of `value` doesn't loop back.
  const emitted = useRef(value);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Markdown has no underline; headings and line breaks get their own versions below.
        underline: false,
        heading: false,
        hardBreak: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" },
      }),
      // Headings show as a bold line, like in a posted comment, and "# " doesn't make one: a
      // comment isn't a document. Ones already in a comment still survive an edit.
      Heading.extend({ addInputRules: () => [] }),
      // Newlines are line breaks (as on GitHub), so a break is a plain one, not "  \n".
      HardBreak.extend({ renderMarkdown: () => "\n" }),
      TableKit.configure({ table: { resizable: false } }),
      TableShortcuts,
      Placeholder.configure({ placeholder }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: { class: cn("markdown selectable outline-none", className) },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          props.current.onSubmit();
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          props.current.onCancel();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        if (props.current.onPasteFiles(data)) return true;
        return editorRef.current ? pasteText(editorRef.current, data) : false;
      },
    },
    onUpdate: ({ editor }) => {
      // Without the blank lines of empty paragraphs at either end (the one kept after a table or code block).
      const markdown = editor.isEmpty ? "" : editor.getMarkdown().replace(/^\n+|\s+$/g, "");
      emitted.current = markdown;
      props.current.onChange(markdown);
    },
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  // A value changed from outside (a draft cleared or restored) replaces the content.
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    // After any text it starts with (an edit).
    if (autoFocus && editor) editor.commands.focus("end", { scrollIntoView: false });
  }, [autoFocus, editor]);

  return <EditorContent editor={editor} />;
}
