/**
 * シンタックスハイライタの vendor エントリ (Issue #155)。
 *
 * **`highlight.js` の全部入り (`highlight.js` の default export) を使わない。** あれは
 * 190 以上の言語を抱えていて 1MB 近くになる。yomi がツリーに載せるのは
 * `src/util/text-ext.ts` の allowlist だけなので、**そこに出てくる言語だけ**を登録する。
 *
 * ## 登録する言語は `TEXT_LANGUAGES` / `TEXT_FILENAMES` の値と一致させる
 *
 * サーバが返す `lang` は必ずこの表のどれかになる。ここに無い言語 ID が来ると
 * highlight.js は**例外を投げず、ハイライトせずに素通しする**ので画面は壊れないが、
 * 「登録し忘れた言語が静かに無色になる」ことになる。**一致は
 * `tests/vendor-bundle.test.ts` が機械的に検証する**ので、`text-ext.ts` に言語を
 * 足したらここにも足すこと（忘れると CI で落ちる）。
 *
 * `plaintext` は highlight.js の組み込みなので登録しない。
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("less", less);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("php", php);
hljs.registerLanguage("protobuf", protobuf);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

export default hljs;
