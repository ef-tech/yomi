/**
 * 特性テスト: エディタ / 保存 / 競合 責務 (Issue #77)
 *
 * 編集モードの出入り、dirty 表示、楽観ロック (baseSha) 付き保存、409 競合バナーの
 * 3 択の振る舞いを固定する。判定は DOM と POST の中身だけで行う。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  type BootOptions,
  bootApp,
  resetAppEnvironment,
} from "./helpers/app-harness.ts";

/**
 * **`README.md` を開いた状態で起動する** (Issue #145 / #150)。
 *
 * このファイルの主題は「開いているファイルを編集・保存する」ことで、**どのファイルが
 * 開くかは主題ではない**。`bootApp()` の既定は**ルート直下の README**（Issue #150）で、
 * 無ければツリー最初のファイル（`defaultTree()` を実サーバの並び＝ディレクトリが先に
 * 直した結果 `docs/deep/note.md`。Issue #145）に落ちる。
 *
 * **主題でないものを既定に委ねない**ので、ここでは `?path=` で明示する
 * —— fixture の並びや初期ファイル選択の規則が変わっても壊れない。
 */
const boot = (options: BootOptions = {}) =>
  bootApp({ url: "http://localhost:3944/?path=README.md", ...options });

let h: AppHarness;

afterEach(resetAppEnvironment);

/** editor に文字を入れて input を発火する (ユーザーのタイプ相当) */
function type(harness: AppHarness, value: string) {
  const editor = harness.el<HTMLTextAreaElement>("editor");
  editor.value = value;
  editor.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
}

/** 保存 POST だけを取り出す */
function savePosts(harness: AppHarness) {
  return harness.fetchCalls.filter((c) => c.url === "/api/file" && c.method === "POST");
}

async function enterEdit(harness: AppHarness) {
  harness.click(harness.el("edit-btn"));
  await harness.flush();
}

describe("編集モードの出入り", () => {
  test("編集ボタンで editor が現れ、TOC は一時的に無効になる", async () => {
    h = await boot();
    expect(h.el<HTMLTextAreaElement>("editor").hidden).toBe(true);

    await enterEdit(h);

    const editor = h.el<HTMLTextAreaElement>("editor");
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe(h.files["README.md"]?.raw ?? "");
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el("edit-btn").getAttribute("aria-pressed")).toBe("true");
    expect(h.el<HTMLButtonElement>("discard-btn").hidden).toBe(false);
    expect(h.el<HTMLButtonElement>("toc-btn").disabled).toBe(true);
    expect(h.el<HTMLButtonElement>("toc-fab").disabled).toBe(true);
  });

  test("未編集のまま完了すると保存せずに編集モードを抜ける", async () => {
    h = await boot();
    await enterEdit(h);
    h.click(h.el("edit-btn"));
    await h.flush();

    expect(savePosts(h)).toHaveLength(0);
    expect(h.el<HTMLTextAreaElement>("editor").hidden).toBe(true);
    expect(h.el("edit-btn").getAttribute("aria-pressed")).toBe("false");
    expect(h.el<HTMLButtonElement>("toc-btn").disabled).toBe(false);
  });

  test("開いているファイルが無ければ編集モードに入れない", async () => {
    h = await boot({ tree: { type: "dir", name: "", path: "", children: [] }, files: {} });
    expect(h.el<HTMLButtonElement>("edit-btn").disabled).toBe(true);

    h.click(h.el("edit-btn"));
    await h.flush();
    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
  });

  test("別ファイルを開くと編集モードは解除される", async () => {
    h = await boot();
    await enterEdit(h);

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
    expect(h.el<HTMLTextAreaElement>("editor").hidden).toBe(true);
  });
});

describe("dirty 表示", () => {
  test("内容を変えると dirty インジケータが出て、戻すと消える", async () => {
    h = await boot();
    await enterEdit(h);
    const original = h.files["README.md"]?.raw ?? "";

    expect(h.el("dirty-indicator").hidden).toBe(true);
    type(h, `${original}追記`);
    expect(h.el("dirty-indicator").hidden).toBe(false);

    type(h, original);
    expect(h.el("dirty-indicator").hidden).toBe(true);
  });

  test("dirty なら beforeunload を preventDefault する", async () => {
    h = await boot();
    await enterEdit(h);

    const clean = new h.window.Event("beforeunload", { cancelable: true });
    h.window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    type(h, "変更");
    const dirty = new h.window.Event("beforeunload", { cancelable: true });
    h.window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe("保存", () => {
  test("完了ボタンで baseSha 付きの POST を送り、成功したら編集モードを抜ける", async () => {
    h = await boot();
    await enterEdit(h);
    type(h, "# 新しい内容\n");

    h.click(h.el("edit-btn"));
    await h.flush(6);

    expect(savePosts(h)).toHaveLength(1);
    expect(savePosts(h)[0]?.body).toEqual({
      path: "README.md",
      body: "# 新しい内容\n",
      baseSha: "sha-readme-1",
    });
    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
    expect(h.el("dirty-indicator").hidden).toBe(true);
    expect(h.el("status").classList.contains("is-ok")).toBe(true);
  });

  test("保存に成功するとプレビューと md ソースがサーバ応答で置き換わる", async () => {
    h = await boot();
    h.renderHtml = (raw) => `<h1 id="saved">${raw.trim()}</h1>`;
    await enterEdit(h);
    type(h, "保存後\n");

    h.keydown(h.document, { key: "s", code: "KeyS", ctrlKey: true });
    await h.flush(6);

    expect(h.el("preview").innerHTML).toContain("保存後");
    expect(h.el("source").textContent).toBe("保存後\n");
    // 編集モードは維持されたまま (Ctrl+S は保存だけ)
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
  });

  test("Ctrl/Cmd+S は編集モードのときだけ保存する", async () => {
    h = await boot();
    h.keydown(h.document, { key: "s", code: "KeyS", metaKey: true });
    await h.flush();
    expect(savePosts(h)).toHaveLength(0);

    await enterEdit(h);
    type(h, "内容\n");
    h.keydown(h.document, { key: "s", code: "KeyS", metaKey: true });
    await h.flush(6);
    expect(savePosts(h)).toHaveLength(1);
  });

  test("2 回目の保存は 1 回目で返ってきた sha を baseSha に使う", async () => {
    h = await boot();
    await enterEdit(h);
    type(h, "1回目\n");
    h.keydown(h.document, { key: "s", code: "KeyS", ctrlKey: true });
    await h.flush(6);

    type(h, "2回目\n");
    h.keydown(h.document, { key: "s", code: "KeyS", ctrlKey: true });
    await h.flush(6);

    const posts = savePosts(h);
    expect(posts).toHaveLength(2);
    // 1 回目は起動時に読んだ sha。2 回目は 1 回目の応答が返した新しい sha を使うので、
    // 競合せずに反映される (古い sha のままなら 409 になり conflict バナーが出る)
    expect(posts[0]?.body?.baseSha).toBe("sha-readme-1");
    expect(posts[1]?.body?.baseSha).not.toBe(posts[0]?.body?.baseSha);
    expect(h.el("conflict-banner").hidden).toBe(true);
    expect(h.files["README.md"]?.raw).toBe("2回目\n");
  });

  test("保存に失敗したら編集モードを維持し status をエラーにする", async () => {
    h = await boot();
    await enterEdit(h);
    type(h, "だめ\n");
    h.intercept = (url, method) =>
      url === "/api/file" && method === "POST"
        ? { status: 500, body: { error: "disk full" } }
        : undefined;

    h.click(h.el("edit-btn"));
    await h.flush(6);

    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el("dirty-indicator").hidden).toBe(false);
    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });

  test("Tab で 2 スペースを挿入し dirty になる", async () => {
    h = await boot();
    await enterEdit(h);
    const editor = h.el<HTMLTextAreaElement>("editor");
    editor.value = "ab";
    editor.selectionStart = 1;
    editor.selectionEnd = 1;

    h.keydown(editor, { key: "Tab" });

    expect(editor.value).toBe("a  b");
    expect(editor.selectionStart).toBe(3);
    expect(h.el("dirty-indicator").hidden).toBe(false);
  });
});

describe("破棄と離脱の確認", () => {
  test("dirty なら破棄ボタンで確認し、キャンセルすると編集を続ける", async () => {
    h = await boot();
    await enterEdit(h);
    type(h, "捨てたくない\n");

    h.confirmResult = false;
    h.click(h.el("discard-btn"));
    await h.flush();

    expect(h.confirmMessages).toHaveLength(1);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("捨てたくない\n");
  });

  test("確認を了承すると保存せずに編集モードを抜ける", async () => {
    h = await boot();
    await enterEdit(h);
    type(h, "捨てる\n");

    h.confirmResult = true;
    h.click(h.el("discard-btn"));
    await h.flush();

    expect(savePosts(h)).toHaveLength(0);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
  });

  test("dirty で別ファイルへ移ろうとすると確認し、キャンセルすると遷移しない", async () => {
    h = await boot();
    await enterEdit(h);
    type(h, "未保存\n");
    h.confirmResult = false;
    const calls = h.historyCalls.length;

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.confirmMessages).toHaveLength(1);
    expect(h.el("current-path").textContent).toBe("README.md");
    expect(h.historyCalls).toHaveLength(calls);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
  });

  test("dirty でなければ確認せずに遷移する", async () => {
    h = await boot();
    await enterEdit(h);

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.confirmMessages).toHaveLength(0);
    expect(h.el("current-path").textContent).toBe("docs/guide.md");
  });
});

describe("保存競合 (409)", () => {
  /** 外部でファイルが書き換わった状態を作り、編集内容を保存しようとする */
  async function provokeConflict(harness: AppHarness) {
    await enterEdit(harness);
    type(harness, "ローカル版\n");
    const file = harness.files["README.md"];
    if (file) {
      file.raw = "サーバ版\n";
      file.html = "<p>サーバ版</p>";
      file.sha = "sha-readme-2";
    }
    harness.click(harness.el("edit-btn"));
    await harness.flush(6);
  }

  test("競合するとバナーが出て、編集内容は保持される", async () => {
    h = await boot();
    await provokeConflict(h);

    expect(h.el("conflict-banner").hidden).toBe(false);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("ローカル版\n");
    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });

  test("「サーバ版を採用」でサーバ内容に置き換わり dirty が落ちる", async () => {
    h = await boot();
    await provokeConflict(h);

    h.click(h.el("conflict-take-server"));
    await h.flush();

    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("サーバ版\n");
    expect(h.el("source").textContent).toBe("サーバ版\n");
    expect(h.el("preview").innerHTML).toContain("サーバ版");
    expect(h.el("dirty-indicator").hidden).toBe(true);
    expect(h.el("conflict-banner").hidden).toBe(true);
    // 採用は再保存しない (POST は競合した 1 回だけ)
    expect(savePosts(h)).toHaveLength(1);
  });

  test("「ローカル版で上書き」は baseSha 無しで再送する", async () => {
    h = await boot();
    await provokeConflict(h);

    h.click(h.el("conflict-overwrite"));
    await h.flush(6);

    const posts = savePosts(h);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ path: "README.md", body: "ローカル版\n" });
    expect(posts[1]?.body).not.toHaveProperty("baseSha");
    expect(h.el("conflict-banner").hidden).toBe(true);
    expect(h.el("dirty-indicator").hidden).toBe(true);
    expect(h.files["README.md"]?.raw).toBe("ローカル版\n");
  });

  test("「閉じる」はバナーだけ閉じ、編集内容もサーバ内容も変えない", async () => {
    h = await boot();
    await provokeConflict(h);

    h.click(h.el("conflict-dismiss"));
    await h.flush();

    expect(h.el("conflict-banner").hidden).toBe(true);
    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("ローカル版\n");
    expect(h.files["README.md"]?.raw).toBe("サーバ版\n");
    expect(savePosts(h)).toHaveLength(1);
  });
});

// **競合の差分ダイアログ (Issue #57)。**
//
// バナーだけだと「どちらを残すか」を中身を見ずに決めることになる。差分を見てから
// 選べること、そして**選ぶまでローカル編集が失われないこと**を固定する。
describe("保存競合の差分ダイアログ (Issue #57)", () => {
  /** 外部でファイルが書き換わった状態を作り、編集内容を保存しようとする */
  async function provokeConflict(harness: AppHarness, local: string, server: string) {
    await enterEdit(harness);
    type(harness, local);
    const file = harness.files["README.md"];
    if (file) {
      file.raw = server;
      file.html = `<p>${server}</p>`;
      file.sha = "sha-readme-2";
    }
    harness.click(harness.el("edit-btn"));
    await harness.flush(6);
  }

  const dialog = () => h.el("conflict-diff");
  const rows = () => h.qa("#conflict-diff-body .conflict-diff-row");
  /** 差分行を `+foo` / `-foo` / ` foo` にして読みやすくする */
  const sketch = () =>
    rows().map((el) => {
      const sign = el.querySelector(".conflict-diff-sign")?.textContent ?? "";
      const text = el.querySelector(".conflict-diff-text")?.textContent ?? "";
      return `${sign}${text}`;
    });

  async function openDiff(local: string, server: string) {
    h = await boot();
    await provokeConflict(h, local, server);
    h.click(h.el("conflict-show-diff"));
    await h.flush();
  }

  test("バナーの「差分を見る」でダイアログが開く", async () => {
    h = await boot();
    await provokeConflict(h, "ローカル版\n", "サーバ版\n");
    expect(dialog().hidden).toBe(true);

    h.click(h.el("conflict-show-diff"));
    await h.flush();

    expect(dialog().hidden).toBe(false);
  });

  // **DoD 1: 両方の内容と差分を確認してから選択できる**
  test("ローカルにしかない行とサーバにしかない行が両方出る", async () => {
    await openDiff("共通\nローカルだけ\n", "共通\nサーバだけ\n");

    expect(sketch()).toEqual([" 共通", "-ローカルだけ", "+サーバだけ", " "]);
  });

  test("差分の記号が色に依存せず読める（- がローカル、+ がサーバ）", async () => {
    await openDiff("a\n", "b\n");

    const del = h.q(".conflict-diff-row.is-del");
    const add = h.q(".conflict-diff-row.is-add");
    expect(del.querySelector(".conflict-diff-sign")?.textContent).toBe("-");
    expect(add.querySelector(".conflict-diff-sign")?.textContent).toBe("+");
  });

  test("行番号を出す（片側にしか無い行はその側の番号）", async () => {
    await openDiff("a\nb\n", "a\nX\n");

    const numbers = rows().map((el) => el.querySelector(".conflict-diff-no")?.textContent);
    expect(numbers).toEqual(["1", "2", "2", "3"]);
  });

  test("内容が同じなら「同じです」と伝える", async () => {
    // sha だけずれて中身が同じケース（保存タイミングの行き違い）
    await openDiff("同じ内容\n", "同じ内容\n");

    expect(h.el("conflict-diff-summary").textContent).toContain("同じ");
    expect(rows().every((el) => el.classList.contains("is-equal"))).toBe(true);
  });

  test("差分の件数を左右で言い切って伝える", async () => {
    await openDiff("共通\nローカルだけ\n", "共通\nサーバだけ\n");

    const summary = h.el("conflict-diff-summary").textContent ?? "";
    expect(summary).toContain("ローカル版にしかない行 1 行");
    expect(summary).toContain("サーバ版にしかない行 1 行");
  });

  // **DoD 2: 選択前にローカル内容が失われない**
  test("差分を見てもエディタの内容は変わらない", async () => {
    await openDiff("ローカル版\n", "サーバ版\n");

    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("ローカル版\n");
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    // まだ何も保存していない（競合した 1 回だけ）
    expect(savePosts(h)).toHaveLength(1);
  });

  test("閉じるだけならローカルもサーバも変わらない", async () => {
    await openDiff("ローカル版\n", "サーバ版\n");

    h.click(h.el("conflict-diff-close"));
    await h.flush();

    expect(dialog().hidden).toBe(true);
    // バナーは残る（まだ競合は解決していない）
    expect(h.el("conflict-banner").hidden).toBe(false);
    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("ローカル版\n");
    expect(h.files["README.md"]?.raw).toBe("サーバ版\n");
    expect(savePosts(h)).toHaveLength(1);
  });

  // **DoD 4: 各選択肢の状態遷移**
  test("ダイアログから「サーバ内容を取り込む」が選べる", async () => {
    await openDiff("ローカル版\n", "サーバ版\n");

    h.click(h.el("conflict-diff-take-server"));
    await h.flush();

    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("サーバ版\n");
    expect(h.el("dirty-indicator").hidden).toBe(true);
    expect(dialog().hidden).toBe(true);
    expect(h.el("conflict-banner").hidden).toBe(true);
    // 採用は再保存しない
    expect(savePosts(h)).toHaveLength(1);
  });

  test("ダイアログから「強制上書き」が選べる", async () => {
    await openDiff("ローカル版\n", "サーバ版\n");

    h.click(h.el("conflict-diff-overwrite"));
    await h.flush(6);

    const posts = savePosts(h);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).not.toHaveProperty("baseSha");
    expect(h.files["README.md"]?.raw).toBe("ローカル版\n");
    expect(dialog().hidden).toBe(true);
    expect(h.el("conflict-banner").hidden).toBe(true);
  });

  test("ローカル版・サーバ版をそれぞれコピーできる", async () => {
    await openDiff("ローカル版\n", "サーバ版\n");

    h.click(h.el("conflict-diff-copy-local"));
    await h.flush();
    expect(h.clipboard.at(-1)).toBe("ローカル版\n");

    h.click(h.el("conflict-diff-copy-server"));
    await h.flush();
    expect(h.clipboard.at(-1)).toBe("サーバ版\n");
  });

  // **DoD 3: キーボードとスクリーンリーダーで操作できる**
  describe("キーボードと支援技術", () => {
    test("開くとフォーカスが差分本体に入る（いきなり破壊的な選択肢に当てない）", async () => {
      await openDiff("ローカル版\n", "サーバ版\n");

      expect(h.document.activeElement).toBe(h.el("conflict-diff-body"));
    });

    test("Esc で閉じ、開く前にフォーカスがあった場所へ戻る", async () => {
      await openDiff("ローカル版\n", "サーバ版\n");
      // 競合は編集中に起きるので、開く直前のフォーカスはエディタにある
      expect(dialog().hidden).toBe(false);

      h.keydown(h.el("conflict-diff-body"), { key: "Escape" });
      await h.flush();

      expect(dialog().hidden).toBe(true);
      expect(h.document.activeElement).toBe(h.el("editor"));
    });

    // **フォールバック（戻り先が消えていたとき）は jsdom では確認できない。**
    // 採用・上書きを選ぶとバナーごと閉じるので、実ブラウザなら戻り先が非表示になって
    // `focus()` が空振りする。だが **jsdom は `hidden` を無視して `focus()` を通す**ので
    // （実測: `el.hidden = true` の後でも `activeElement` がその要素になる）、
    // ここに書いても実装を消して通る空テストにしかならない。実装側にはフォールバックが
    // あり、実ブラウザで「取り込み後にフォーカスが editor へ返る」ことを確認している。

    // 最前面 (z-index 70) なので、1 回の Esc で背後まで閉じてはいけない
    test("Esc は差分ダイアログだけを閉じ、背後の sidebar は開いたまま", async () => {
      h = await boot({ mobile: true });
      h.click(h.el("menu-btn"));
      expect(h.el("sidebar").classList.contains("is-open")).toBe(true);
      await provokeConflict(h, "ローカル版\n", "サーバ版\n");
      h.click(h.el("conflict-show-diff"));
      await h.flush();

      h.keydown(h.el("conflict-diff-body"), { key: "Escape" });
      await h.flush();

      expect(dialog().hidden).toBe(true);
      expect(h.el("sidebar").classList.contains("is-open")).toBe(true);
    });

    // フォーカスがパネル外に落ちてもキー処理が届く（capture で拾っている）
    test("フォーカスが body にあっても Esc が効く", async () => {
      await openDiff("ローカル版\n", "サーバ版\n");
      h.el("conflict-diff-body").blur();

      h.keydown(h.document.body, { key: "Escape" });
      await h.flush();

      expect(dialog().hidden).toBe(true);
    });

    // `aria-modal="true"` を宣言している以上、背後へ抜けられてはいけない
    test("Tab がダイアログ内で循環する", async () => {
      await openDiff("ローカル版\n", "サーバ版\n");

      const focusables = h.qa<HTMLElement>(
        "#conflict-diff button:not([disabled]), #conflict-diff [tabindex='0']",
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) throw new Error("フォーカスできる要素が無い");

      last.focus();
      h.keydown(last, { key: "Tab" });
      expect(h.document.activeElement).toBe(first);

      h.keydown(first, { key: "Tab", shiftKey: true });
      expect(h.document.activeElement).toBe(last);
    });

    test("IME 変換中の Esc では閉じない", async () => {
      await openDiff("ローカル版\n", "サーバ版\n");

      const ev = new h.window.KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      h.el("conflict-diff-body").dispatchEvent(ev);
      await h.flush();

      expect(dialog().hidden).toBe(false);
    });

    test("ダイアログとして名前が付き、状態が読み上げられる", async () => {
      await openDiff("ローカル版\n", "サーバ版\n");

      expect(dialog().getAttribute("role")).toBe("dialog");
      expect(dialog().getAttribute("aria-modal")).toBe("true");
      expect(dialog().getAttribute("aria-labelledby")).toBe("conflict-diff-title");
      expect(h.el("conflict-diff-title").textContent?.trim()).not.toBe("");
      // 件数は live region で伝える
      expect(h.el("conflict-diff-summary").getAttribute("role")).toBe("status");
      // 差分本体はキーボードでスクロールできる
      expect(h.el<HTMLElement>("conflict-diff-body").tabIndex).toBe(0);
      expect(h.el("conflict-diff-body").getAttribute("aria-label")).toBeTruthy();
    });
  });

  describe("大きな文書", () => {
    test("上限を超えたら差分を出さず、選択肢だけ残す", async () => {
      const local = Array.from({ length: 4000 }, (_, i) => `L${i}`).join("\n");
      const server = Array.from({ length: 4000 }, (_, i) => `S${i}`).join("\n");
      await openDiff(local, server);

      expect(rows()).toHaveLength(0);
      expect(h.el("conflict-diff-truncated").hidden).toBe(false);
      // 空の枠と凡例は出さない（差分を出そうとして失敗したように見えるため）
      expect(h.el("conflict-diff-body").hidden).toBe(true);
      expect(h.el("conflict-diff-legend").hidden).toBe(true);
      // 中身を見て選ぶ手段は残っている
      expect(h.el<HTMLButtonElement>("conflict-diff-take-server").disabled).toBe(false);
      expect(h.el<HTMLButtonElement>("conflict-diff-overwrite").disabled).toBe(false);
      expect(h.el<HTMLButtonElement>("conflict-diff-copy-local").disabled).toBe(false);
      // 差分本体が消えているので、フォーカスは次の要素（コピー）へ回る
      expect(h.document.activeElement).toBe(h.el("conflict-diff-copy-local"));
    });

    test("差分が小さければ長い文書でも表示する", async () => {
      const common = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      const local = common.join("\n");
      const server = [...common.slice(0, 1500), "サーバが直した行", ...common.slice(1501)].join(
        "\n",
      );
      await openDiff(local, server);

      expect(h.el("conflict-diff-truncated").hidden).toBe(true);
      expect(h.el("conflict-diff-body").hidden).toBe(false);
      expect(rows().length).toBeGreaterThan(0);
      // 離れた同一行は畳まれているので、3000 行がそのまま出たりしない
      expect(rows().length).toBeLessThan(20);
      expect(h.qa("#conflict-diff-body .conflict-diff-skip").length).toBeGreaterThan(0);
    });
  });

  // **エディタ以外からも競合は起きる。** プレビューのチェックボックスを切り替えた保存は
  // 編集モードでないので、エディタは空。それをローカル版として出すと「自分の変更が全部
  // 消えている」という嘘になる（レビューで発覚）。
  describe("エディタ以外の経路（プレビューのチェックボックス）", () => {
    async function provokeCheckboxConflict(harness: AppHarness) {
      const file = harness.files["README.md"];
      if (!file) throw new Error("fixture が無い");
      file.raw = "- [ ] やること\n";
      file.html = '<ul><li><input type="checkbox" data-task-index="0"> やること</li></ul>';
      file.sha = "sha-task-1";
      harness.click(harness.treeItem("README.md"));
      await harness.flush(4);

      const box = harness.q<HTMLInputElement>('#preview input[type="checkbox"]');
      // サーバ側だけ先に進める
      file.raw = "- [ ] やること\n- [ ] 増えた行\n";
      file.sha = "sha-task-2";

      box.checked = true;
      box.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
      await harness.flush(6);
      return box;
    }

    test("チェックを反映した本文をローカル版として差分に出す（エディタの空文字ではない）", async () => {
      h = await boot();
      await provokeCheckboxConflict(h);
      expect(h.el("conflict-banner").hidden).toBe(false);
      expect(h.el<HTMLTextAreaElement>("editor").value).toBe(""); // エディタは空のまま

      h.click(h.el("conflict-show-diff"));
      await h.flush();

      // ローカル版は「チェックを付けた本文」であって空文字ではない
      const shown = sketch();
      expect(shown).toContain("-- [x] やること");
      expect(shown).toContain("+- [ ] やること");
      expect(shown).toContain("+- [ ] 増えた行");
    });

    test("編集モードでなくても「強制上書き」が効く（無言で終わらない）", async () => {
      h = await boot();
      await provokeCheckboxConflict(h);
      h.click(h.el("conflict-show-diff"));
      await h.flush();

      h.click(h.el("conflict-diff-overwrite"));
      await h.flush(6);

      const posts = savePosts(h);
      expect(posts).toHaveLength(2);
      expect(posts[1]?.body).not.toHaveProperty("baseSha");
      expect(h.files["README.md"]?.raw).toBe("- [x] やること\n");
      expect(h.el("conflict-banner").hidden).toBe(true);
    });
  });

  // 差分を読んでいる最中に watcher の通知が重なると、画面は古いままスナップショットだけが
  // 新しくなる。そのまま「取り込む」を押すと**見ていない内容**が入る（レビューで発覚）
  test("開いている間にサーバ内容が差し替わったら差分を描き直す", async () => {
    await openDiff("ローカル版\n", "サーバ版1\n");
    expect(sketch()).toContain("+サーバ版1");

    // watcher の 2 発目相当
    const file = h.files["README.md"];
    if (file) {
      file.raw = "サーバ版2\n";
      file.html = "<p>サーバ版2</p>";
      file.sha = "sha-readme-3";
    }
    h.ws.emit({ type: "changed", path: "README.md" });
    await h.flush(6);

    expect(sketch()).toContain("+サーバ版2");
    expect(sketch()).not.toContain("+サーバ版1");
  });

  test("コピーの結果をパネル内にも出す（スクリムの下に隠れないように）", async () => {
    await openDiff("ローカル版\n", "サーバ版\n");
    expect(h.el("conflict-diff-notice").hidden).toBe(true);

    h.click(h.el("conflict-diff-copy-local"));
    await h.flush();

    expect(h.el("conflict-diff-notice").hidden).toBe(false);
    expect(h.el("conflict-diff-notice").textContent).toContain("コピー");
    expect(h.el("conflict-diff-notice").getAttribute("role")).toBe("status");
  });

  // ファイル名も中身も利用者のものなので、HTML として解釈してはいけない (#21 / #59 の方針)
  test("差分の中身を HTML として解釈しない", async () => {
    await openDiff("<img src=x onerror=alert(1)>\n", "サーバ版\n");

    expect(h.q("#conflict-diff-body").querySelector("img")).toBeNull();
    expect(h.el("conflict-diff-body").textContent).toContain("<img src=x onerror=alert(1)>");
  });

  // サーバ側でファイルが消えていると raw が null で返る
  test("サーバ側のファイルが消えていても壊れない", async () => {
    h = await boot();
    await enterEdit(h);
    type(h, "ローカル版\n");
    h.intercept = (url, method) => {
      if (url !== "/api/file" || method !== "POST") return undefined;
      return {
        status: 409,
        body: {
          error: "ファイルが他で更新されています",
          path: "README.md",
          raw: null,
          html: "",
          sha: null,
        },
      };
    };
    h.click(h.el("edit-btn"));
    await h.flush(6);

    h.click(h.el("conflict-show-diff"));
    await h.flush();

    expect(dialog().hidden).toBe(false);
    // サーバ側が空なので、ローカルの中身がまるごと「ローカルにしかない行」になる
    // (末尾の空行は両側に共通なので equal)
    expect(sketch()).toEqual(["-ローカル版", " "]);
  });
});
