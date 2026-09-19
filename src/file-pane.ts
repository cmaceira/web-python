import type { Workspace } from './workspace';
import { LAST_RUN_LABEL, RUNNING_LABEL } from './format';
import { isInert, setInert } from './controls';

export interface FilePaneOptions {
  toggle: HTMLButtonElement;
  pane: HTMLElement;
  list: HTMLElement;
  resizer: HTMLElement;
  nameInput: HTMLInputElement;
  newButton: HTMLButtonElement;
  renameButton: HTMLButtonElement;
  deleteButton: HTMLButtonElement;
  onSelect(name: string): void;
  onCreate(name: string): void;
  onRename(from: string, to: string): void;
  onDelete(name: string): void;
}

type EditMode = 'create' | 'rename' | null;

/** Small accessible flat tree; folders are intentionally outside this course scope. */
export class FilePane {
  private workspace: Workspace | null = null;
  private mode: EditMode = null;
  private desktopInitialized = false;
  private runningFile: string | null = null;
  private lastRunFile: string | null = null;
  private editingLocked = false;

  constructor(private readonly options: FilePaneOptions) {
    const { toggle, pane, nameInput, newButton, renameButton, deleteButton, resizer } = options;
    const wide = window.matchMedia('(min-width: 700px)');
    const syncLayout = (): void => {
      if (wide.matches) {
        if (!this.desktopInitialized) pane.hidden = false;
        this.desktopInitialized = true;
      } else {
        pane.hidden = true;
        this.desktopInitialized = false;
      }
      toggle.setAttribute('aria-expanded', String(!pane.hidden));
      resizer.hidden = !wide.matches || pane.hidden;
    };
    syncLayout();
    wide.addEventListener('change', syncLayout);
    toggle.addEventListener('click', () => {
      pane.hidden = !pane.hidden;
      toggle.setAttribute('aria-expanded', String(!pane.hidden));
      resizer.hidden = !wide.matches || pane.hidden;
    });
    newButton.addEventListener('click', () => this.begin('create'));
    renameButton.addEventListener('click', () => this.begin('rename'));
    deleteButton.addEventListener('click', () => this.deleteActive());
    nameInput.addEventListener('keydown', (event) => this.handleNameKey(event));
    resizer.addEventListener('pointerdown', (event) => this.startResize(event, pane, resizer));
    resizer.addEventListener('keydown', (event) => this.handleResizeKey(event, pane, resizer));
  }

  render(workspace: Workspace): void {
    this.workspace = workspace;
    const { list, newButton, renameButton, deleteButton } = this.options;
    const active = workspace.activeFile;
    list.replaceChildren(
      ...workspace.names().map((name) => {
        const item = document.createElement('li');
        item.className = 'file-tree-item';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'file-tree-button';
        button.dataset.file = name;
        button.setAttribute('role', 'treeitem');
        button.setAttribute('aria-selected', String(name === active));
        button.tabIndex = name === active ? 0 : -1;
        button.textContent = name;
        const runState = name === this.runningFile
          ? RUNNING_LABEL
          : name === this.lastRunFile
            ? LAST_RUN_LABEL
            : null;
        if (runState !== null) {
          const state = document.createElement('span');
          state.className = 'file-run-state';
          state.textContent = ` · ${runState}`;
          button.dataset.runState = runState === RUNNING_LABEL ? 'running' : 'last';
          button.setAttribute('aria-label', `${name}, ${runState}`);
          button.append(state);
        }
        button.addEventListener('click', () => this.options.onSelect(name));
        button.addEventListener('keydown', (event) => this.handleTreeKey(event, name));
        item.append(button);
        return item;
      }),
    );
    const hasActive = active !== null;
    setInert(newButton, this.editingLocked);
    setInert(renameButton, this.editingLocked || !hasActive);
    setInert(deleteButton, this.editingLocked || !hasActive);
  }

  /** Render the session-only execution state without changing the workspace. */
  setRunState(runningFile: string | null, lastRunFile: string | null): void {
    this.runningFile = runningFile;
    this.lastRunFile = lastRunFile;
    if (this.workspace !== null) this.render(this.workspace);
  }

  /** Prevent workspace mutations while execution owns its immutable snapshot. */
  setEditingLocked(locked: boolean): void {
    this.editingLocked = locked;
    if (locked) this.endEdit();
    if (this.workspace !== null) this.render(this.workspace);
  }

  private begin(mode: Exclude<EditMode, null>): void {
    if (this.editingLocked) return;
    const { nameInput } = this.options;
    if (mode === 'rename' && this.workspace?.activeFile === null) return;
    this.mode = mode;
    nameInput.hidden = false;
    nameInput.value = mode === 'rename' ? this.workspace?.activeFile ?? '' : '';
    nameInput.placeholder = mode === 'rename' ? 'New file name' : 'File name';
    nameInput.focus();
    nameInput.select();
  }

  private handleNameKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.endEdit();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = this.options.nameInput.value;
    const mode = this.mode;
    const from = this.workspace?.activeFile;
    this.endEdit();
    if (mode === 'create') this.options.onCreate(name);
    if (mode === 'rename' && from !== null && from !== undefined) this.options.onRename(from, name);
  }

  private endEdit(): void {
    this.mode = null;
    this.options.nameInput.hidden = true;
    this.options.nameInput.value = '';
  }

  private deleteActive(): void {
    if (this.editingLocked || isInert(this.options.deleteButton)) return;
    const name = this.workspace?.activeFile;
    if (name === null || name === undefined) return;
    if (!window.confirm(`Delete ${name}?`)) return;
    this.options.onDelete(name);
  }

  private setWidth(width: number, pane: HTMLElement, resizer: HTMLElement): void {
    const bounded = Math.min(480, Math.max(160, Math.round(width)));
    document.documentElement.style.setProperty('--files-width', `${bounded}px`);
    pane.style.width = `${bounded}px`;
    resizer.setAttribute('aria-valuenow', String(bounded));
  }

  private startResize(event: PointerEvent, pane: HTMLElement, resizer: HTMLElement): void {
    if (window.matchMedia('(min-width: 700px)').matches === false) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = pane.getBoundingClientRect().width;
    resizer.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent): void => this.setWidth(startWidth + move.clientX - startX, pane, resizer);
    const onEnd = (): void => {
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onEnd);
      resizer.removeEventListener('pointercancel', onEnd);
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onEnd);
    resizer.addEventListener('pointercancel', onEnd);
  }

  private handleResizeKey(event: KeyboardEvent, pane: HTMLElement, resizer: HTMLElement): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    this.setWidth(pane.getBoundingClientRect().width + direction * step, pane, resizer);
  }

  private handleTreeKey(event: KeyboardEvent, name: string): void {
    const names = this.workspace?.names() ?? [];
    const index = names.indexOf(name);
    let next: string | null = null;
    if (event.key === 'ArrowDown') next = names[index + 1] ?? names[0] ?? null;
    if (event.key === 'ArrowUp') next = names[index - 1] ?? names.at(-1) ?? null;
    if (event.key === 'Home') next = names[0] ?? null;
    if (event.key === 'End') next = names.at(-1) ?? null;
    if (event.key === 'F2') {
      event.preventDefault();
      this.begin('rename');
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      this.deleteActive();
      return;
    }
    if (next !== null) {
      event.preventDefault();
      this.options.onSelect(next);
      queueMicrotask(() => this.options.list.querySelector<HTMLButtonElement>(`[data-file=${CSS.escape(next!)}]`)?.focus());
    }
  }
}
