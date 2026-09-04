# igniter · kickstart handover

寫給下一個 session 的交接。讀完這份就能直接開下一張票。2026-09-03 くるみ整理，2026-09-04 更新。

## 這是什麼

一個很小的軟體工廠：Linear 票拖進 `Ready to build` → dispatch 認領、在 Herdr 開 workspace 讓 Commander 照 igniter 自帶的規則跑 → Owner 看證據、在 Linear 把票改成 Ready to merge。網頁左欄是 dispatch 的視角：Building（進行中的票、跑了多久）與 Dispatch（Queue 認領順序與理由、Activity 決定紀錄、Workflow 規則全文）；右欄看三個 pane 的畫面、打字回覆（2026-09-04 定案，原型與規格見 STA-164）。
dispatch（2026-09-04 前叫 runner）與網頁是同一個 Bun 程序，**在工廠主機（minipc）上、repo 目錄裡跑**（`cd <repo> && igniter serve`），repo 就是專案目錄；隊友經 Tailscale 連。

- Linear project：https://linear.app/starcoder/project/igniter-ee3d3db6bd6c （team Starcoder，票 STA-158～169）
- 完整背景、名詞、決策：Linear 專案文件「新 session 先讀：背景、名詞、決策」
  https://linear.app/starcoder/document/新-session-先讀背景名詞決策-8d677e0bd3a6
- Commander 規則：由 igniter 自帶（怎麼餵給 Commander 由 STA-162 定）。草稿目前還在 `~/.agents/skills/feature-delivery/SKILL.md`（缺口清單 `GAPS.md`），搬進 repo 時一起搬；`prototype/workflow.md` 是它去掉 frontmatter 的副本，當 Rules 的假資料。
- 定版 UI 原型（從 `prototype/` 編出）：https://claude.ai/code/artifact/d350b5f2-c48f-4cf4-8827-4da3a0c4448a
- UI 規格文字版：STA-164「定版的 UI」段。**UI 以原型為準，改 UI 就要同步改票。**

## 開工順序

STA-169（本 repo 骨架）→ STA-168 / STA-166 → STA-167 → STA-161 → STA-158 / STA-159 / STA-160 → STA-162 → STA-164 → STA-163 / STA-165。
169、168、166 已在 Todo，其餘 Backlog。每張票的「驗收條件」就是完成定義。

## 技術選型（細節在 STA-169）

- Bun runtime + `bun install`；Solid `2.0.0-rc.6` + `@solidjs/router 2.0.0-next.21` + `@solidjs/vite-plugin` + Vite 8；TypeScript 7；typebox。版本鎖死，不用 `^`。
- 樣式：Tailwind v4 + `basecoat-css` 1.0.2，只用 CSS，不載它的 JS。
  Basecoat 1.0 的變體走屬性：`class="btn" data-variant="outline" data-size="sm"`，不是 `.btn-outline`。
- token 三層：Tailwind 尺度 → shadcn 語意變數（`theme.css`）→ 專案元件 CSS（只讀 `var(--color-*)`、`var(--spacing)`）。
- 配色定案 **Sand**（暖石中性色、墨黑主色），檔案就是 `prototype/theme.css`，之後搬到 `src/web/theme.css`，將來跨專案共用。
- 字型 Geist + Geist Mono（Google Fonts）。深色模式是 `html.dark`，自己切 class。
- 終端畫面：`pane.read` 純文字塞 `<pre>`，不用 xterm；三個 pane 同時顯示、選一格放大。放大那格底下的輸入列走 `pane.send_input`，y / n 走 `pane.send_keys`。
- 單一 package：`src/herdr`、`src/linear`、`src/dispatch`、`src/server`、`src/web`、`src/cli.ts`。
- 前端寫法照 `~/Dev/openchan`：先搬它的 `docs/solid-2.0/`（CHEATSHEET 與 RFC）與 AGENTS.md「寫 Solid 前先讀 cheatsheet」規則。

## prototype/ 目錄

原型的原始檔，markup 與 class 可以直接搬進 Solid：

- `theme.css`：正式的 token 檔（Sand），含 `--terminal` / `--terminal-foreground` / `--terminal-muted` 三個終端 token。
- `igniter.css`：專案元件（rail、slot、阻塞列、pane、rules）。
- `app.css`：`@import "tailwindcss"; @import "basecoat-css"; @import "./theme.css"; @import "./igniter.css";` 正式專案就是這條鏈。
- `gen_page.py` 產生 `page.html`（假資料在 `SLOTS`，Rules 內文讀 `workflow.md`），`page.js` 是原型互動；`build.py` 跑 Tailwind CLI 編譯後把 CSS 內嵌成 `dist/igniter-basecoat.html`。

重跑：`cd prototype && bun install && python3 gen_page.py && python3 build.py`，開 `dist/local.html`。

## 工作慣例

- 命名用具體領域字眼，不用 Resolver / Manager / Helper / Util 這類後綴。
- 只做票要求的事，不加多餘抽象；使用者輸入觸發動作一律原生 `<form onSubmit>`。
- 不用零星（0 star）第三方套件；Herdr socket client 自己寫（STA-167）。
- `LINEAR_API_KEY` 只從環境變數讀，不進 repo；Linear 存取一律 GraphQL，不用 MCP（Commander 可能是 codex / opencode）。
- GitHub：repo 放 `github.com/minipai/igniter`，`gh` 維持 `claudecafe` 登入；需要使用者權限時
  `GH_TOKEN=$(gh auth token --user minipai) gh …`，絕不 `gh auth switch`。不開 PR：審查用 diffwalk 發布連結貼到票上，Ready to merge 後 rebase 到本機 `main`，不 push，由 Owner 推。
- Commit：`--author="くるみ <kurumi@claudecafe.dev>"`，訊息英文，不加 Co-Authored-By。
- Herdr metadata 的 source 統一 `igniter`；agent pane 命名 `commander-<票號>`、`builder-<票號>`、`reviewer-<票號>`。
- blocked 超過 20 分鐘只是 stalled，不算失敗、不關 workspace；`max_hours`（4）才失敗。
- 主機 minipc（Ubuntu、Tailscale）；上面 Sunshine / 虛擬顯示器設定不要動。

## 還沒定的小事

- spark 的模型 id（暫定 `openai/gpt-5.3-codex-spark`）要跟使用者確認。
- dispatch 怎麼把 Commander 規則餵給三種 kind（讀檔、常數、還是別的），做 STA-162 時實測。
- 使用者要自己建 Linear issue template（`## 驗收條件` checklist）並把 igniter project 加到側欄最愛。
