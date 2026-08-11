/**
 * クイックオープンの UI とキーボード操作 (Issue #54)。
 *
 * 候補の絞り込み・順位づけは `tests/quick-open.test.ts` が純粋関数として見る。
 * ここは **DOM とキーボードの結線**だけを見る —— Ctrl/Cmd+P で開くか、↑↓ で
 * 選択が動くか、Enter で `navigateTo` を通るか、未保存確認が働くか。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AppHarness, bootApp, resetAppEnvironment } from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

const panel = () => h.el("quick-open");
const input = () => h.el<HTMLInputElement>("quick-open-input");
const items = () => h.qa<HTMLButtonElement>(".quick-open-item");
const activeItem = () => h.q<HTMLButtonElement>(".quick-open-item.is-active");

/** 入力欄に値を入れて input を発火する（ハーネスに type ヘルパは無い） */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new h.window.Event("input", { bubbles: true }));
}

/** Ctrl+P（capture phase で拾われる） */
function pressCtrlP() {
  h.keydown(h.document, { key: "p", code: "KeyP", ctrlKey: true });
}

async function open() {
  pressCtrlP();
  await h.flush();
}

describe("クイックオープン", () => {
  test("Ctrl/Cmd+P で開き、入力欄にフォーカスが移る", async () => {
    h = await bootApp();
    expect(panel().hidden).toBe(true);

    await open();

    expect(panel().hidden).toBe(false);
    expect(h.document.activeElement).toBe(input());
  });

  test("もう一度押すと閉じる", async () => {
    h = await bootApp();
    await open();
    await open();
    expect(panel().hidden).toBe(true);
  });

  test("Esc で閉じる", async () => {
    h = await bootApp();
    await open();

    h.keydown(input(), { key: "Escape" });
    await h.flush();
    expect(panel().hidden).toBe(true);
  });

  test("背景をクリックすると閉じる（パネル内は閉じない）", async () => {
    h = await bootApp();
    await open();

    h.click(panel());
    await h.flush();
    expect(panel().hidden).toBe(true);
  });

  test("開いた直後は全ファイルが候補に出て、先頭が選択されている", async () => {
    h = await bootApp();
    await open();

    // ハーネスの既定 fixture は README.md / docs/guide.md / docs/deep/note.md。
    // クエリが空なら document order (= ツリーの並び) で返る。
    expect(items().map((b) => b.dataset.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "docs/deep/note.md",
    ]);
    expect(activeItem()?.dataset.path).toBe("README.md");
    expect(activeItem()?.getAttribute("aria-selected")).toBe("true");
  });

  test("入力で候補が絞られ、選択は先頭へ戻る", async () => {
    h = await bootApp();
    await open();

    typeInto(input(), "readme");
    await h.flush();

    expect(items().map((b) => b.dataset.path)).toEqual(["README.md"]);
    expect(activeItem()?.dataset.path).toBe("README.md");
  });

  test("一致しなければ空表示にする", async () => {
    h = await bootApp();
    await open();

    typeInto(input(), "zzzz");
    await h.flush();

    expect(items()).toHaveLength(0);
    expect(h.el("quick-open-empty").hidden).toBe(false);
  });

  // **マウスなしで完結する** (DoD 1 行目)
  test("↑↓ で選択が動き、端で循環する", async () => {
    h = await bootApp();
    await open();
    expect(activeItem()?.dataset.path).toBe("README.md");

    h.keydown(input(), { key: "ArrowDown" });
    expect(activeItem()?.dataset.path).toBe("docs/guide.md");

    h.keydown(input(), { key: "ArrowDown" });
    expect(activeItem()?.dataset.path).toBe("docs/deep/note.md");

    // 末尾から下 → 先頭へ回る
    h.keydown(input(), { key: "ArrowDown" });
    expect(activeItem()?.dataset.path).toBe("README.md");

    // 先頭から上 → 末尾へ回る
    h.keydown(input(), { key: "ArrowUp" });
    expect(activeItem()?.dataset.path).toBe("docs/deep/note.md");
  });

  test("Enter で選択中のファイルを開き、パネルを閉じる", async () => {
    h = await bootApp();
    await open();

    h.keydown(input(), { key: "ArrowDown" }); // docs/guide.md
    h.keydown(input(), { key: "Enter" });
    await h.flush();

    expect(panel().hidden).toBe(true);
    expect(h.el("current-path").textContent).toBe("docs/guide.md");
  });

  test("候補をクリックしても開ける", async () => {
    h = await bootApp();
    await open();

    const target = items().find((b) => b.dataset.path === "docs/deep/note.md");
    if (!target) throw new Error("候補が見つかりません");
    h.click(target);
    await h.flush();

    expect(panel().hidden).toBe(true);
    expect(h.el("current-path").textContent).toBe("docs/deep/note.md");
  });

  test("候補が無いまま Enter を押しても何も起きない", async () => {
    h = await bootApp();
    await open();
    typeInto(input(), "zzzz");
    await h.flush();

    const before = h.el("current-path").textContent;
    h.keydown(input(), { key: "Enter" });
    await h.flush();

    expect(h.el("current-path").textContent).toBe(before);
    // 候補が無いときは開いたまま (誤って閉じない)
    expect(panel().hidden).toBe(false);
  });

  // **遷移は navigateTo に委ねているので、未保存確認が従来どおり働く** (DoD 4 行目)。
  // 独自の遷移経路を作っていないことが、この 2 本で担保される。
  test("未保存編集中に開くと確認が出て、キャンセルすれば遷移しない", async () => {
    h = await bootApp();
    const before = h.el("current-path").textContent;
    h.click(h.el("edit-btn"));
    await h.flush();
    typeInto(h.el<HTMLTextAreaElement>("editor"), "編集中");
    await h.flush();

    // **編集中でも開ける** (未保存の確認は navigateTo が持っている)
    await open();
    expect(panel().hidden).toBe(false);

    h.confirmResult = false; // 破棄をキャンセルする
    h.keydown(input(), { key: "ArrowDown" });
    h.keydown(input(), { key: "Enter" });
    await h.flush();

    // 確認が出て、遷移していない。編集内容も残っている
    expect(h.confirmMessages.length).toBeGreaterThan(0);
    expect(h.el("current-path").textContent).toBe(before);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("編集中");
  });

  test("未保存編集中でも、確認で OK すれば遷移して編集モードを抜ける", async () => {
    h = await bootApp();
    h.click(h.el("edit-btn"));
    await h.flush();
    typeInto(h.el<HTMLTextAreaElement>("editor"), "編集中");
    await h.flush();

    await open();
    h.confirmResult = true; // 破棄して続行する
    h.keydown(input(), { key: "ArrowDown" });
    h.keydown(input(), { key: "Enter" });
    await h.flush();

    expect(h.confirmMessages.length).toBeGreaterThan(0);
    expect(h.el("current-path").textContent).toBe("docs/guide.md");
    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
  });

  // **Esc の優先順位。** このリポジトリは Esc をリスナー登録順とガードで捌いており、
  // 過去にそれで壊している。クイックオープンは最前面 (z-index 60) なので常に最優先で、
  // 1 回の Esc で背後まで閉じてはいけない。
  test("Esc はクイックオープンだけを閉じ、背後の sidebar は開いたまま", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("menu-btn"));
    expect(h.el("sidebar").classList.contains("is-open")).toBe(true);

    await open();
    h.keydown(input(), { key: "Escape" });
    await h.flush();

    expect(panel().hidden).toBe(true);
    expect(h.el("sidebar").classList.contains("is-open")).toBe(true);
  });

  test("Esc はクイックオープンだけを閉じ、外部 URL バナーは出たまま", async () => {
    h = await bootApp();
    const a = h.document.createElement("a");
    a.setAttribute("href", "https://example.com/");
    h.el("preview").appendChild(a);
    h.click(a);
    expect(h.el("external-link-banner").hidden).toBe(false);

    await open();
    h.keydown(input(), { key: "Escape" });
    await h.flush();

    expect(panel().hidden).toBe(true);
    expect(h.el("external-link-banner").hidden).toBe(false);
  });

  test("候補ボタンは tab 順から外れている (aria-activedescendant で選択を伝える)", async () => {
    h = await bootApp();
    await open();
    expect(items().every((b) => b.tabIndex === -1)).toBe(true);

    const first = items()[0];
    if (!first) throw new Error("候補が 1 件も無い");
    expect(input().getAttribute("aria-activedescendant")).toBe(first.id);
  });

  // **IME 変換中のキーを横取りしない。** 日本語のファイル名を打っている最中、変換確定の
  // Enter がそのまま「候補を開く」になると、打ち終わる前に別のファイルへ飛ぶ。
  describe("IME 変換中", () => {
    /** `isComposing: true` の keydown を送る */
    function composingKeydown(key: string) {
      const ev = new h.window.KeyboardEvent("keydown", {
        key,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      input().dispatchEvent(ev);
      return ev;
    }

    test("Enter でファイルを開かない（変換確定を横取りしない）", async () => {
      h = await bootApp();
      const before = h.el("current-path").textContent;
      await open();

      composingKeydown("Enter");
      await h.flush();

      expect(h.el("current-path").textContent).toBe(before);
      expect(panel().hidden).toBe(false);
    });

    test("↑↓ で選択を動かさない（IME の変換候補を選ばせる）", async () => {
      h = await bootApp();
      await open();
      expect(activeItem()?.dataset.path).toBe("README.md");

      composingKeydown("ArrowDown");
      expect(activeItem()?.dataset.path).toBe("README.md");
    });

    test("Esc で閉じない（変換のキャンセルを横取りしない）", async () => {
      h = await bootApp();
      await open();

      composingKeydown("Escape");
      await h.flush();

      expect(panel().hidden).toBe(false);
    });
  });

  // **フォーカスがパネルの外にあってもキー操作が効く。**
  //
  // パネル内には空リスト帯やリストの padding、スクロールバーといった**フォーカスを取れない
  // 可視領域**があり、実ブラウザではそこを mousedown すると `activeElement` が `<body>` に
  // 戻る。リスナーをパネル要素に付けているとそこで処理系が丸ごと迂回され、
  // 「Esc でパネルが閉じず、背後の sidebar だけが閉じる」という逆向きの壊れ方をする。
  // （jsdom はそのフォーカス挙動を実装していないので、body へ直接キーを送って再現する）
  describe("フォーカスがパネルの外に落ちているとき", () => {
    test("Esc でパネルが閉じ、背後の sidebar は開いたまま", async () => {
      h = await bootApp({ mobile: true });
      h.click(h.el("menu-btn"));
      expect(h.el("sidebar").classList.contains("is-open")).toBe(true);
      await open();

      h.keydown(h.document.body, { key: "Escape" });
      await h.flush();

      expect(panel().hidden).toBe(true);
      expect(h.el("sidebar").classList.contains("is-open")).toBe(true);
    });

    test("↑↓ で候補を選び、Enter で開ける", async () => {
      h = await bootApp();
      await open();
      expect(activeItem()?.dataset.path).toBe("README.md");

      h.keydown(h.document.body, { key: "ArrowDown" });
      expect(activeItem()?.dataset.path).toBe("docs/guide.md");

      h.keydown(h.document.body, { key: "Enter" });
      await h.flush();
      expect(h.el("current-path").textContent).toBe("docs/guide.md");
    });

    test("Tab でフォーカスを入力欄へ引き戻す", async () => {
      h = await bootApp();
      await open();
      // blur でフォーカスが body に落ちた状態を作る（実ブラウザで空白を mousedown した状態）
      input().blur();
      expect(h.document.activeElement).not.toBe(input());

      h.keydown(h.document.body, { key: "Tab" });
      expect(h.document.activeElement).toBe(input());
    });
  });

  // `aria-modal="true"` と宣言している以上、Tab で背後へ抜けられてはいけない。
  //
  // **jsdom は Tab によるフォーカス移動を実装していない**ので、「フォーカスが外へ出ない」を
  // そのまま書くと**実装を消しても通る空テスト**になる (実測で確認済み)。代わりに実装の契約
  // ——「既定動作を打ち消し、入力欄へ戻す」——を、`defaultPrevented` と、パネル内の別要素から
  // 戻ることの 2 点で見る。
  test("Tab は既定動作を打ち消してフォーカスを入力欄へ戻す", async () => {
    h = await bootApp();
    await open();

    const send = (target: EventTarget, shiftKey: boolean) => {
      const ev = new h.window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(ev);
      return ev;
    };

    expect(send(input(), false).defaultPrevented).toBe(true);
    expect(send(input(), true).defaultPrevented).toBe(true);

    // パネル内の別要素にフォーカスが渡っていても入力欄へ引き戻す
    const first = items()[0];
    if (!first) throw new Error("候補が 1 件も無い");
    first.focus();
    expect(h.document.activeElement).toBe(first);
    send(first, false);
    expect(h.document.activeElement).toBe(input());
  });

  test("候補が無いとき aria-expanded を false にする", async () => {
    h = await bootApp();
    await open();
    expect(input().getAttribute("aria-expanded")).toBe("true");

    typeInto(input(), "zzzz");
    await h.flush();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  // **⋮ から開いたときも、閉じたらフォーカスの起点が残る。**
  // 戻り先の `#overflow-quick-open` は閉じたメニューの中にいるので `focus()` が空振りする
  // （`isConnected` は true なので素朴なガードではすり抜ける）。実機で `<body>` に落ちた。
  test("⋮ メニューから開いて閉じても、フォーカスが body に落ちない", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("overflow-btn"));
    h.click(h.el("overflow-quick-open"));
    await h.flush();
    expect(panel().hidden).toBe(false);

    h.keydown(input(), { key: "Escape" });
    await h.flush();

    expect(panel().hidden).toBe(true);
    expect(h.document.activeElement).not.toBe(h.document.body);
    expect(h.document.activeElement).toBe(h.el("overflow-btn"));
  });

  test("スマホの ⋮ メニューからも開ける（編集中も含む）", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("edit-btn"));
    await h.flush();

    h.click(h.el("overflow-btn"));
    h.click(h.el("overflow-quick-open"));
    await h.flush();

    expect(panel().hidden).toBe(false);
    expect(h.el("overflow-menu").hidden).toBe(true);
  });

  // **除外・depth はサーバ側で適用済み**なので、ツリーに無いものは候補にも出ない (DoD 3 行目)。
  //
  // 母集団に無い文字列を打って 0 件を確認するだけでは同語反復になる（実装が母集団をどう
  // 作っていても 0 件になる）。**サーバには存在するがツリーには出ないファイル**を用意して、
  // 候補がツリー由来であることを見る。
  test("サーバにあってもツリーに無ければ候補に出ない", async () => {
    h = await bootApp({
      tree: {
        name: ".",
        path: "",
        type: "dir",
        // `.yomiignore` や --depth で落ちた想定。ツリーには secret.md が無い
        children: [{ name: "README.md", path: "README.md", type: "file" }],
      },
      files: {
        "README.md": { raw: "r", html: "<p>r</p>", sha: "s1" },
        "secret.md": { raw: "秘密", html: "<p>秘密</p>", sha: "s2" },
      },
    });
    await open();

    // 何も打たない状態（= 全件）にも出ない
    expect(items().map((b) => b.dataset.path)).toEqual(["README.md"]);

    typeInto(input(), "secret");
    await h.flush();
    expect(items()).toHaveLength(0);
    expect(h.el("quick-open-empty").hidden).toBe(false);
  });

  // **ファイル名は利用者のディスク上の名前**なので `<` や `&` を含みうる。
  // `appendHighlighted` が innerHTML を使わない設計をテストで固定する（次に触る人が戻せないように）。
  test("HTML メタ文字を含むファイル名を要素として解釈しない", async () => {
    const name = "<img src=x onerror=alert(1)>&amp;.md";
    const nasty = `docs/${name}`;
    h = await bootApp({
      tree: {
        name: ".",
        path: "",
        type: "dir",
        children: [
          {
            name: "docs",
            path: "docs",
            type: "dir",
            children: [{ name, path: nasty, type: "file" }],
          },
        ],
      },
      files: { [nasty]: { raw: "x", html: "<p>x</p>", sha: "s1" } },
    });
    await open();
    typeInto(input(), "img");
    await h.flush();

    const item = items()[0];
    if (!item) throw new Error("候補が出ていない");
    // 要素として生えていない
    expect(item.querySelector("img")).toBeNull();
    // 生の文字列がそのままテキストとして出ている（`&amp;` が `&` に解釈されてもいない）
    expect(item.textContent).toContain(name);
    expect(item.dataset.path).toBe(nasty);
  });

  test("一致した文字がハイライトされる", async () => {
    h = await bootApp();
    await open();
    typeInto(input(), "rdm");
    await h.flush();

    const marks = h.qa("#quick-open-list mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((m) => m.textContent?.toLowerCase()).join("")).toBe("rdm");
  });

  // **絵文字入りのファイル名でハイライトが割れない。** 候補検索はコードポイント index を
  // 返すので、描画側が UTF-16 のコードユニットで数えると 1 つずつずれ、`<mark>` に
  // サロゲートの片割れが入って `�` になる（実機で踏んだ）。
  test("絵文字入りのファイル名でもハイライトが壊れない", async () => {
    h = await bootApp({
      tree: {
        name: ".",
        path: "",
        type: "dir",
        children: [
          {
            name: "docs",
            path: "docs",
            type: "dir",
            children: [{ name: "📁メモ帳.md", path: "docs/📁メモ帳.md", type: "file" }],
          },
        ],
      },
      files: { "docs/📁メモ帳.md": { raw: "x", html: "<p>x</p>", sha: "s1" } },
    });
    await open();
    typeInto(input(), "メモ");
    await h.flush();

    expect(items().map((b) => b.dataset.path)).toEqual(["docs/📁メモ帳.md"]);

    const marks = h.qa("#quick-open-list mark");
    expect(marks.map((m) => m.textContent).join("")).toBe("メモ");

    // 孤立サロゲート（U+D800〜U+DFFF）が 1 つも残っていない
    const rendered = h.el("quick-open-list").textContent ?? "";
    expect(/[\uD800-\uDFFF]/.test(rendered.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(
      false,
    );
    // 絵文字そのものは（ハイライトされずに）残っている
    expect(rendered).toContain("📁");
  });

  // **開いたまま watcher の tree イベントが来たら候補も引き直す。** 母集団だけ更新して
  // 表示を放置すると、消えたファイルが一覧に残って Enter で 404 になる。
  test("パネルを開いたままツリーが更新されたら候補も追随する", async () => {
    h = await bootApp();
    await open();
    expect(items().map((b) => b.dataset.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "docs/deep/note.md",
    ]);

    // docs/guide.md が消え、docs/added.md が増えた
    h.tree = {
      name: ".",
      path: "",
      type: "dir",
      children: [
        { name: "README.md", path: "README.md", type: "file" },
        {
          name: "docs",
          path: "docs",
          type: "dir",
          children: [{ name: "added.md", path: "docs/added.md", type: "file" }],
        },
      ],
    };
    h.files["docs/added.md"] = { raw: "a", html: "<p>a</p>", sha: "s9" };
    h.ws.emit({ type: "tree" });
    await h.flush();

    expect(items().map((b) => b.dataset.path)).toEqual(["README.md", "docs/added.md"]);
  });

  test("閉じるとフォーカスが元の要素へ戻る", async () => {
    h = await bootApp();
    const editBtn = h.el("edit-btn");
    editBtn.focus();

    await open();
    expect(h.document.activeElement).toBe(input());

    h.keydown(input(), { key: "Escape" });
    await h.flush();
    expect(h.document.activeElement).toBe(editBtn);
  });

  test("ファイル名は主、ディレクトリは従として並べる（同名の区別）", async () => {
    h = await bootApp({
      tree: {
        name: ".",
        path: "",
        type: "dir",
        children: [
          {
            name: "a",
            path: "a",
            type: "dir",
            children: [{ name: "guide.md", path: "a/guide.md", type: "file" }],
          },
          {
            name: "b",
            path: "b",
            type: "dir",
            children: [{ name: "guide.md", path: "b/guide.md", type: "file" }],
          },
        ],
      },
      files: {
        "a/guide.md": { raw: "a", html: "<p>a</p>", sha: "s1" },
        "b/guide.md": { raw: "b", html: "<p>b</p>", sha: "s2" },
      },
    });
    await open();
    typeInto(input(), "guide");
    await h.flush();

    const paths = items().map((b) => b.dataset.path);
    expect(paths).toEqual(["a/guide.md", "b/guide.md"]);
    // 同名でもディレクトリで区別できる
    expect(items()[0]?.querySelector(".qo-dir")?.textContent).toBe("a");
    expect(items()[1]?.querySelector(".qo-dir")?.textContent).toBe("b");
  });
  // **`errorText` の import 漏れの回帰テスト (Issue #79)。**
  //
  // `navigateTo` が reject したときに status へ出そうとするが、`app-quick-open.js` は
  // `errorText` を import しておらず `ReferenceError` になっていた。型チェックを
  // 入れたことで見つかったので、実行時にも固定しておく。
  //
  // reject 経路は狭い（`navigateTo` は読み込み失敗を自分で握り潰す）ので、
  // **`history.pushState` を 1 回だけ落とす**ことで到達させる。
  test("遷移が失敗したらエラーを status に出す（例外で握り潰さない）", async () => {
    h = await bootApp();
    await open();
    h.keydown(input(), { key: "ArrowDown" });

    const original = h.window.history.pushState;
    h.window.history.pushState = () => {
      throw new Error("pushState が落ちた");
    };
    try {
      h.keydown(input(), { key: "Enter" });
      await h.flush();
    } finally {
      h.window.history.pushState = original;
    }

    // **握り潰さず、利用者に見える形で出ている。** import が無いと `errorText` の
    // 解決に失敗してこの catch 自体が落ち、status が更新されない
    expect(h.el("status").textContent).toContain("pushState が落ちた");
  });
});
