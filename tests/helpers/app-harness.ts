/**
 * public/app.js を jsdom 上で起動するテストハーネス (Issue #77)。
 *
 * app.js は import しただけで全ての配線 (`wire*`) と `init()` / `connectLiveReload()` を
 * 実行するモジュールなので、「関数を呼んで検証する」形にはできない。代わりに
 *
 *   1. index.html から jsdom を作る
 *   2. app.js が読む global (document / window / fetch / WebSocket / matchMedia …) を差し込む
 *   3. `?boot=N` 付きの動的 import で **毎回新しいモジュールインスタンス**を読み込む
 *
 * という順で起動し、**観測可能な振る舞い** (DOM・history・fetch 呼び出し) だけを検証する。
 * app.js の内部関数・内部 state には触れない。#78 の責務分割で内部構造が変わっても、
 * 利用者から見た振る舞いが同じならテストは緑のままであることが要件のため。
 *
 * mermaid の実バンドルは 3.5MB あり import だけで重い。図の描画そのものは E2E (#82) の
 * 担当なので、ここでは「呼ばれたか」だけを観測できるスタブに差し替える。
 * DOMPurify は実物を使う (サニタイズ結果は app.js の描画経路そのものなので差し替えない)。
 */

import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { __resetLangListenersForTest } from "../../public/i18n.js";
import { __resetNavCounterForTest } from "../../public/navigation.js";

/* ===== mermaid スタブ (モジュール登録は import 時に 1 回だけ) ===== */

export interface MermaidStub {
  initializeCalls: unknown[];
  runCalls: unknown[];
  /** 次の run() を失敗させる (描画エラー時の status 表示を検証する用) */
  failNextRun: boolean;
  reset(): void;
}

export const mermaidStub: MermaidStub = {
  initializeCalls: [],
  runCalls: [],
  failNextRun: false,
  reset() {
    this.initializeCalls = [];
    this.runCalls = [];
    this.failNextRun = false;
  },
};

mock.module("../../public/vendor/mermaid.js", () => ({
  default: {
    initialize(config: unknown) {
      mermaidStub.initializeCalls.push(config);
    },
    async run(args: unknown) {
      mermaidStub.runCalls.push(args);
      if (mermaidStub.failNextRun) {
        mermaidStub.failNextRun = false;
        throw new Error("mermaid stub failure");
      }
    },
  },
}));

/* ===== フェイクサーバ ===== */

export interface TreeNode {
  type: "dir" | "file";
  name: string;
  path: string;
  children?: TreeNode[];
}

export interface FakeFile {
  raw: string;
  html: string;
  sha: string;
}

export interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

export interface FetchReply {
  status?: number;
  body: unknown;
}

/** url / method / body を見て応答を差し替える。undefined を返せば既定の挙動。 */
export type FetchInterceptor = (
  url: string,
  method: string,
  body: Record<string, unknown> | null,
) => FetchReply | undefined;

/* ===== matchMedia / IntersectionObserver / WebSocket のフェイク ===== */

class FakeMediaQueryList {
  matches = false;
  readonly listeners = new Set<(ev: { matches: boolean; media: string }) => void>();
  constructor(readonly media: string) {}
  addEventListener(_type: string, fn: (ev: { matches: boolean; media: string }) => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: (ev: { matches: boolean; media: string }) => void) {
    this.listeners.delete(fn);
  }
  /** matches を変更し、変化したときだけ change リスナーへ通知する (実ブラウザと同じ) */
  set(value: boolean) {
    if (this.matches === value) return;
    this.matches = value;
    for (const fn of [...this.listeners]) fn({ matches: value, media: this.media });
  }
}

export interface FakeObserverEntry {
  target: Element;
  isIntersecting: boolean;
  top: number;
}

class FakeIntersectionObserver {
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(
    private readonly cb: (entries: unknown[]) => void,
    readonly options: unknown,
    registry: FakeIntersectionObserver[],
  ) {
    registry.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve(el: Element) {
    const i = this.observed.indexOf(el);
    if (i >= 0) this.observed.splice(i, 1);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.length = 0;
  }
  /** テストから交差状態を流し込む */
  emit(entries: FakeObserverEntry[]) {
    this.cb(
      entries.map((e) => ({
        target: e.target,
        isIntersecting: e.isIntersecting,
        boundingClientRect: { top: e.top },
      })),
    );
  }
}

class FakeWebSocket {
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  closed = false;
  constructor(
    readonly url: string,
    registry: FakeWebSocket[],
  ) {
    registry.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  send() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatch("close", {});
  }
  dispatch(type: string, ev: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  /** サーバからのライブリロード通知を模す */
  emit(msg: unknown) {
    this.dispatch("message", { data: JSON.stringify(msg) });
  }
  /** JSON として壊れたフレームを送る */
  emitRaw(data: string) {
    this.dispatch("message", { data });
  }
}

/* ===== ハーネス本体 ===== */

export interface HistoryCall {
  mode: "push" | "replace";
  url: string;
  state: unknown;
}

export interface BootOptions {
  /** 起動時の URL。`?path=docs/guide.md` で復元経路を検証できる */
  url?: string;
  /** `/api/tree` が返すツリー (既定は defaultTree()) */
  tree?: TreeNode;
  /** `/api/file` が返すファイル群 (既定は defaultFiles()) */
  files?: Record<string, FakeFile>;
  /** localStorage の初期値 */
  storage?: Record<string, string>;
  /** `(max-width: 767px)` の初期値 (スマホ表示) */
  mobile?: boolean;
  /** `(prefers-color-scheme: dark)` の初期値 */
  dark?: boolean;
  /** navigator.language (言語 auto の解決に使う)。既定 "ja" */
  language?: string;
  /**
   * `/api/tree` が返す版 (Issue #126)。既定の `null` は
   * **`X-Yomi-Tree-Gen` を返さないサーバ**で、クライアントは差分を当てず全量を取り直す。
   */
  treeGen?: number | null;
  /** 起動時 (init の /api/tree・/api/file) から効く応答差し替え */
  intercept?: FetchInterceptor;
}

export interface AppHarness {
  dom: JSDOM;
  window: Window & typeof globalThis;
  document: Document;
  /** フェイクサーバのファイル置き場 (テストから直接書き換えてよい) */
  files: Record<string, FakeFile>;
  /** `/api/tree` の応答 (テストから差し替え可) */
  tree: TreeNode;
  /**
   * `/api/tree` が返す版 (Issue #126)。`null` は**ヘッダを返さない古いサーバ**で、
   * その場合クライアントは差分を当てず必ず全量を取り直す。
   */
  treeGen: number | null;
  /** 保存時に raw から html を作る関数 (既定は <p> 包み)。テストで差し替え可 */
  renderHtml: (raw: string) => string;
  /** これまでの fetch 呼び出し */
  fetchCalls: FetchCall[];
  /** 応答の差し替えフック */
  intercept: FetchInterceptor | null;
  /** pushState / replaceState の記録 */
  historyCalls: HistoryCall[];
  /** window.confirm の戻り値 */
  confirmResult: boolean;
  /** window.confirm に渡されたメッセージ */
  confirmMessages: string[];
  /** window.open(url, ...) の記録 */
  openedUrls: string[];
  /** navigator.clipboard.writeText に渡された値 */
  clipboard: string[];
  /** scrollIntoView が呼ばれた要素の id と引数 (jsdom は未実装なのでハーネスが差し込む) */
  scrollIntoViewCalls: { id: string; options: unknown }[];
  /** 生成された IntersectionObserver */
  observers: FakeIntersectionObserver[];
  /** 生成された WebSocket (最後のものが現行接続) */
  sockets: FakeWebSocket[];
  /** 現行の WebSocket */
  ws: FakeWebSocket;
  /** id で要素を引く (無ければ例外) */
  el<T extends Element = HTMLElement>(id: string): T;
  /** CSS セレクタで引く (無ければ例外) */
  q<T extends Element = HTMLElement>(selector: string): T;
  qa<T extends Element = HTMLElement>(selector: string): T[];
  /** ツリー内のファイル/ディレクトリボタンを title (=path) で引く */
  treeItem(path: string): HTMLButtonElement;
  /** クリックを送る (bubbles: true) */
  click(target: Element, init?: MouseEventInit): void;
  /** keydown を送る */
  keydown(target: EventTarget, init: KeyboardEventInit & { code?: string }): void;
  /** メディアクエリの状態を変える */
  setMobile(value: boolean): void;
  setDark(value: boolean): void;
  /** localStorage の生値 */
  storageValue(key: string): string | null;
  /** マイクロ/マクロタスクを流す */
  flush(times?: number): Promise<void>;
  /** 後始末 (jsdom を閉じる) */
  cleanup(): void;
}

const MOBILE_MEDIA = "(max-width: 767px)";
const DARK_MEDIA = "(prefers-color-scheme: dark)";

let bootCounter = 0;

export function defaultTree(): TreeNode {
  return {
    type: "dir",
    name: "",
    path: "",
    children: [
      { type: "file", name: "README.md", path: "README.md" },
      {
        type: "dir",
        name: "docs",
        path: "docs",
        children: [
          { type: "file", name: "guide.md", path: "docs/guide.md" },
          {
            type: "dir",
            name: "deep",
            path: "docs/deep",
            children: [{ type: "file", name: "note.md", path: "docs/deep/note.md" }],
          },
        ],
      },
    ],
  };
}

export function defaultFiles(): Record<string, FakeFile> {
  return {
    "README.md": {
      raw: "# README\n\nhello\n",
      html: '<h1 id="readme" data-line="1">README</h1>\n<p>hello</p>',
      sha: "sha-readme-1",
    },
    "docs/guide.md": {
      raw: "# Guide\n\n## Section\n\ntext\n",
      html: '<h1 id="guide" data-line="1">Guide</h1>\n<h2 id="section" data-line="3">Section</h2>\n<p>text</p>',
      sha: "sha-guide-1",
    },
    "docs/deep/note.md": {
      raw: "# Note\n",
      html: '<h1 id="note" data-line="1">Note</h1>',
      sha: "sha-note-1",
    },
  };
}

/**
 * 差し替え前の global を覚えておき、cleanup() で必ず元へ戻す。
 *
 * bun test は全テストファイルを 1 プロセスで走らせるので、`fetch` や `window` を
 * 差しっぱなしにすると**別ファイルのテストが巻き添えで壊れる** (実際に server.test.ts /
 * daemon.test.ts がハーネスの偽 fetch を掴み、navigation.test.ts が閉じた window を
 * 見て落ちた)。スナップショットは最初の差し替え時の値 = 素の環境。
 */
const pristineGlobals = new Map<string, PropertyDescriptor | undefined>();

function defineGlobal(name: string, value: unknown) {
  if (!pristineGlobals.has(name)) {
    pristineGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function restoreGlobals() {
  for (const [name, descriptor] of pristineGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[name];
  }
  pristineGlobals.clear();
}

/**
 * 差し込んだ global と、モジュールスコープに残る購読・カウンタを素の状態へ戻す。
 *
 * **各テストファイルは `afterEach(resetAppEnvironment)` をそのまま使う。**
 * `harness.cleanup()` 経由にすると、bootApp が途中で例外を投げたテストでは
 * harness 変数が未代入のままになり、差し込んだ global が後続ファイルへ漏れる
 * (漏れると server.test.ts / daemon.test.ts が偽 fetch を掴んで壊れる)。
 * 状態はモジュールスコープにあるので、harness インスタンスが無くても戻せる。
 */
/* ===== app.js が仕込んだタイマーの追跡 ===== */

/**
 * app.js は `setTimeout` で後続処理を仕込む（WebSocket の再接続・toast の消去・
 * エディタへのフォーカス等）。**global を戻すだけでは、保留中のタイマーが残る。**
 *
 * とくに `connectLiveReload` の再接続タイマーは発火時に `location` と `WebSocket` を読むので、
 * テストファイルの境界をまたいで発火すると
 * `ReferenceError: location is not defined` になり、bun が `0 fail / 1 error` で exit 1 する
 * （テスト一覧には出ないので原因が追いにくい）。同一ファイル内で発火すれば次の boot が
 * global を張り直しているため無害なので、**実行速度で結果が変わる間欠failure**になる（Issue #92）。
 *
 * 個別のテストで「再接続を待ち切る」のでは、app.js がタイマーを仕込んだまま終わる
 * どのテストでも再発する。**環境を差し込んだ側が環境を畳む**のが正しいので、ここで追跡して
 * `resetAppEnvironment()` で破棄する。
 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

/** setTimeout / setInterval の戻り値。bun は数値ではなく Timer オブジェクトを返す */
type TimerId = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | number;

const pendingTimeouts = new Set<TimerId>();
const pendingIntervals = new Set<TimerId>();

// global へは defineGlobal(unknown) で入れるので、`typeof setTimeout` へのキャストは要らない
// (Node 型の __promisify__ まで満たす必要が出て、かえって嘘の型になる)
function trackedSetTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): TimerId {
  const holder: { id?: TimerId } = {};
  holder.id = realSetTimeout(
    (...called: unknown[]) => {
      // 発火したものは追跡から外す（clear 対象は「まだ発火していないもの」だけ）
      if (holder.id !== undefined) pendingTimeouts.delete(holder.id);
      (handler as (...a: unknown[]) => void)(...called);
    },
    timeout,
    ...args,
  );
  pendingTimeouts.add(holder.id);
  return holder.id;
}

function trackedClearTimeout(id?: TimerId): void {
  if (id !== undefined) pendingTimeouts.delete(id);
  realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
}

// setInterval は現時点の app.js では使っていないが、責務分割 (#78) で入っても
// 黙って同じ罠に戻らないよう対称に追跡する
function trackedSetInterval(handler: TimerHandler, timeout?: number, ...args: unknown[]): TimerId {
  const id = realSetInterval(handler, timeout, ...args);
  pendingIntervals.add(id);
  return id;
}

function trackedClearInterval(id?: TimerId): void {
  if (id !== undefined) pendingIntervals.delete(id);
  realClearInterval(id as Parameters<typeof clearInterval>[0]);
}

function clearPendingTimers() {
  for (const id of pendingTimeouts) realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
  pendingTimeouts.clear();
  for (const id of pendingIntervals) realClearInterval(id as Parameters<typeof clearInterval>[0]);
  pendingIntervals.clear();
}

export function resetAppEnvironment() {
  // **global を戻す前に**消す。戻した後だと追跡ラッパー自体が外れる
  clearPendingTimers();
  restoreGlobals();
  __resetLangListenersForTest();
  __resetNavCounterForTest();
}

/**
 * DOMPurify 専用の jsdom window を 1 つだけ用意し、そこに束縛する。
 *
 * vendor bundle は「モジュール評価時の globalThis.window」を掴んで離さない
 * (`var k0 = createDOMPurify()`)。素直に最初の boot の window を掴ませると、
 * その boot の cleanup() で window を閉じた瞬間に sanitize() が空文字を返すようになり、
 * **2 テスト目以降のプレビューが黙って空になる**。テスト順序に依存しないよう、
 * 閉じない専用 window を先に掴ませておく。sanitize は文字列を返すので、
 * パースに使う document が描画先と別でも結果は変わらない。
 */
let purifyWindow: JSDOM | null = null;
async function bindDomPurifyOnce() {
  if (purifyWindow) return;
  purifyWindow = new JSDOM("");
  defineGlobal("window", purifyWindow.window);
  defineGlobal("document", purifyWindow.window.document);
  // 型は `public/vendor/dompurify.d.ts` が本体パッケージから再輸出する (Issue #79)
  await import("../../public/vendor/dompurify.js");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function bootApp(options: BootOptions = {}): Promise<AppHarness> {
  await bindDomPurifyOnce();

  // 前のインスタンスが残したモジュールスコープ state を消す。
  // これをしないと navIndex が前テストから引き継がれ、i18n の購読者が積み残る。
  __resetNavCounterForTest();
  __resetLangListenersForTest();
  mermaidStub.reset();

  const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  // pretendToBeVisual は使わない (jsdom 自前の rAF ループがタイマーを持ち続けるため)。
  // requestAnimationFrame はハーネスが global に差し込む。
  const dom = new JSDOM(html, { url: options.url ?? "http://localhost:3944/" });
  const w = dom.window as unknown as Window & typeof globalThis;

  for (const [k, v] of Object.entries(options.storage ?? {})) {
    w.localStorage.setItem(k, v);
  }

  const mediaRegistry = new Map<string, FakeMediaQueryList>();
  const mql = (query: string) => {
    let m = mediaRegistry.get(query);
    if (!m) {
      m = new FakeMediaQueryList(query);
      mediaRegistry.set(query, m);
    }
    return m;
  };
  mql(MOBILE_MEDIA).matches = options.mobile ?? false;
  mql(DARK_MEDIA).matches = options.dark ?? false;
  Object.defineProperty(w, "matchMedia", { value: mql, configurable: true, writable: true });

  const clipboard: string[] = [];
  const scrollIntoViewCalls: { id: string; options: unknown }[] = [];
  const openedUrls: string[] = [];
  const confirmMessages: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const historyCalls: HistoryCall[] = [];
  const observers: FakeIntersectionObserver[] = [];
  const sockets: FakeWebSocket[] = [];

  // isSecureContext を true にして navigator.clipboard 経路を通す
  // (false だと app.js が execCommand フォールバックへ落ち、jsdom が未実装で失敗する)
  Object.defineProperty(w, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(w.navigator, "clipboard", {
    value: {
      async writeText(text: string) {
        clipboard.push(text);
      },
    },
    configurable: true,
  });
  // jsdom の既定は "en-US" で、バージョンによって変わりうる。言語モード auto の解決結果が
  // 環境で揺れるとメッセージ検証が不安定になるため、既定を "ja" に固定する。
  Object.defineProperty(w.navigator, "language", {
    value: options.language ?? "ja",
    configurable: true,
  });

  // jsdom は scrollIntoView を実装していない。deep-link / TOC ジャンプは
  // 「どの要素にスクロールしようとしたか」が観測点なので、記録するだけの実装を入れる。
  Object.defineProperty(w.Element.prototype, "scrollIntoView", {
    value(this: Element, options: unknown) {
      scrollIntoViewCalls.push({ id: this.id, options });
    },
    configurable: true,
    writable: true,
  });

  const state = {
    files: options.files ?? defaultFiles(),
    tree: options.tree ?? defaultTree(),
    treeGen: options.treeGen ?? null,
    renderHtml: (raw: string) => `<p>${escapeHtml(raw)}</p>`,
    intercept: (options.intercept ?? null) as FetchInterceptor | null,
    confirmResult: true,
    shaCounter: 0,
  };

  Object.defineProperty(w, "open", {
    value: (url: string) => {
      openedUrls.push(url);
      return null;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(w, "confirm", {
    value: (msg: string) => {
      confirmMessages.push(msg);
      return state.confirmResult;
    },
    configurable: true,
    writable: true,
  });

  const origPush = w.history.pushState.bind(w.history);
  const origReplace = w.history.replaceState.bind(w.history);
  w.history.pushState = (data: unknown, unused: string, url?: string | null) => {
    historyCalls.push({ mode: "push", url: String(url ?? ""), state: data });
    origPush(data, unused, url);
  };
  w.history.replaceState = (data: unknown, unused: string, url?: string | null) => {
    historyCalls.push({ mode: "replace", url: String(url ?? ""), state: data });
    origReplace(data, unused, url);
  };

  /** フェイクサーバ。実 API (src/server.ts) の応答形だけを模す。 */
  const fakeFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    fetchCalls.push({ url, method, body });

    const reply = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const forced = state.intercept?.(url, method, body);
    if (forced) return reply(forced.status ?? 200, forced.body);

    if (url.startsWith("/api/tree")) {
      // **版ヘッダも返す (Issue #126)。** 実サーバはここに `X-Yomi-Tree-Gen` を載せ、
      // クライアントはそれを基準に差分を当てるか全量へ逃げるかを決める。
      // `treeGen` が `null` のテストは**ヘッダを返さない古いサーバ**を表す
      return new Response(JSON.stringify(state.tree), {
        status: 200,
        headers:
          state.treeGen === null
            ? { "Content-Type": "application/json" }
            : { "Content-Type": "application/json", "X-Yomi-Tree-Gen": String(state.treeGen) },
      });
    }

    if (url.startsWith("/api/file/create")) {
      const path = String(body?.path ?? "");
      if (state.files[path]) {
        return reply(409, { error: "already exists", code: "already_exists" });
      }
      state.shaCounter += 1;
      state.files[path] = { raw: "", html: "", sha: `sha-new-${state.shaCounter}` };
      return reply(200, { path });
    }

    if (url.startsWith("/api/file")) {
      if (method === "GET") {
        const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
        const file = state.files[path];
        if (!file) return reply(404, { error: "not found", code: "not_found" });
        return reply(200, { path, raw: file.raw, html: file.html, sha: file.sha });
      }
      const path = String(body?.path ?? "");
      const file = state.files[path];
      if (!file) return reply(404, { error: "not found", code: "not_found" });
      const baseSha = body?.baseSha;
      if (typeof baseSha === "string" && baseSha !== file.sha) {
        // 楽観ロックの衝突: サーバ側の最新スナップショットを添えて 409
        return reply(409, {
          error: "conflict",
          code: "conflict",
          path,
          raw: file.raw,
          html: file.html,
          sha: file.sha,
        });
      }
      const raw = String(body?.body ?? "");
      state.shaCounter += 1;
      const next: FakeFile = {
        raw,
        html: state.renderHtml(raw),
        sha: `sha-${path}-${state.shaCounter}`,
      };
      state.files[path] = next;
      return reply(200, { path, raw: next.raw, html: next.html, sha: next.sha });
    }

    return reply(404, { error: "no route", code: "not_found" });
  };

  // app.js が読む global を差し込む。**動的 import より前**でなければならない
  // (DOMPurify は import 時に window を捕まえ、app.js は import 時に els を組み立てるため)。
  defineGlobal("window", w);
  defineGlobal("document", w.document);
  defineGlobal("navigator", w.navigator);
  defineGlobal("location", w.location);
  defineGlobal("localStorage", w.localStorage);
  defineGlobal("Event", w.Event);
  defineGlobal("CustomEvent", w.CustomEvent);
  defineGlobal("MouseEvent", w.MouseEvent);
  defineGlobal("KeyboardEvent", w.KeyboardEvent);
  defineGlobal("Node", w.Node);
  defineGlobal("HTMLElement", w.HTMLElement);
  defineGlobal("fetch", fakeFetch);
  // app.js が仕込むタイマーを追跡できるよう、差し替え版を global に置く。
  // これが無いと、保留中のタイマーが resetAppEnvironment 後に発火して復元済み global を触る (#92)
  defineGlobal("setTimeout", trackedSetTimeout);
  defineGlobal("clearTimeout", trackedClearTimeout);
  defineGlobal("setInterval", trackedSetInterval);
  defineGlobal("clearInterval", trackedClearInterval);
  defineGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    return Number(trackedSetTimeout(() => cb(0), 0));
  });
  defineGlobal("cancelAnimationFrame", (id: number) => trackedClearTimeout(id));
  defineGlobal(
    "IntersectionObserver",
    class extends FakeIntersectionObserver {
      constructor(cb: (entries: unknown[]) => void, opts: unknown) {
        super(cb, opts, observers);
      }
    },
  );
  defineGlobal(
    "WebSocket",
    class extends FakeWebSocket {
      constructor(url: string) {
        super(url, sockets);
      }
    },
  );

  // flush 自身のタイマーは追跡しない (待ってから進むので clear 対象にする意味がなく、
  // 追跡すると「消したい app.js のタイマー」と混ざる)
  const flush = async (times = 4) => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    }
  };

  bootCounter += 1;
  await import(`../../public/app.js?boot=${bootCounter}`);
  await flush();

  const el = <T extends Element = HTMLElement>(id: string): T => {
    const found = w.document.getElementById(id);
    if (!found) throw new Error(`要素が見つかりません: #${id}`);
    return found as unknown as T;
  };
  const q = <T extends Element = HTMLElement>(selector: string): T => {
    const found = w.document.querySelector(selector);
    if (!found) throw new Error(`要素が見つかりません: ${selector}`);
    return found as unknown as T;
  };

  const harness: AppHarness = {
    dom,
    window: w,
    document: w.document,
    get files() {
      return state.files;
    },
    get tree() {
      return state.tree;
    },
    set tree(next: TreeNode) {
      state.tree = next;
    },
    get treeGen() {
      return state.treeGen;
    },
    set treeGen(next: number | null) {
      state.treeGen = next;
    },
    get renderHtml() {
      return state.renderHtml;
    },
    set renderHtml(fn: (raw: string) => string) {
      state.renderHtml = fn;
    },
    fetchCalls,
    get intercept() {
      return state.intercept;
    },
    set intercept(fn: FetchInterceptor | null) {
      state.intercept = fn;
    },
    historyCalls,
    get confirmResult() {
      return state.confirmResult;
    },
    set confirmResult(v: boolean) {
      state.confirmResult = v;
    },
    confirmMessages,
    openedUrls,
    clipboard,
    scrollIntoViewCalls,
    observers,
    sockets,
    get ws() {
      const last = sockets[sockets.length - 1];
      if (!last) throw new Error("WebSocket がまだ作られていません");
      return last;
    },
    el,
    q,
    qa: <T extends Element = HTMLElement>(selector: string): T[] =>
      Array.from(w.document.querySelectorAll(selector)) as unknown as T[],
    treeItem: (path: string) => q<HTMLButtonElement>(`#tree .tree-item[title="${path}"]`),
    click: (target: Element, init: MouseEventInit = {}) => {
      target.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    },
    keydown: (target: EventTarget, init: KeyboardEventInit & { code?: string }) => {
      target.dispatchEvent(
        new w.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );
    },
    setMobile: (value: boolean) => mql(MOBILE_MEDIA).set(value),
    setDark: (value: boolean) => mql(DARK_MEDIA).set(value),
    storageValue: (key: string) => w.localStorage.getItem(key),
    flush,
    // window は閉じない。閉じると、遅延して発火する app.js のタイマー (toast の 3s 等) が
    // 破棄済み window を触りに行く。global さえ戻せば他ファイルへの影響は無く、
    // jsdom は参照が切れれば GC される。
    //
    cleanup: resetAppEnvironment,
  };
  return harness;
}
