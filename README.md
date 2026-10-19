# AI 額度小工具

iPhone 主畫面小工具，同時顯示 **Claude**（5 小時／每週）和 **Codex** 的已用額度與重置倒數。

## 安裝

1. App Store 下載 **Scriptable**（免費）。
2. 在 Scriptable 新增腳本，把 `ai-usage-widget.js` 的內容整段貼上，命名為「AI 額度」。
3. 在 App 裡執行一次，依選單設定：
   - **Claude sessionKey**：電腦瀏覽器登入 claude.ai → 開發者工具 → Application → Cookies → `sessionKey`（`sk-ant-sid01-…`）。
   - **Codex token**：登入 chatgpt.com 後打開 `https://chatgpt.com/api/auth/session`，複製 `accessToken`；
     或用電腦上 `~/.codex/auth.json` 裡的 `access_token`（多個工作區時，順便填 `account_id`）。
4. 回主畫面 → 長按 → 加入 Scriptable 小工具，選 **中** 尺寸 → 編輯小工具 → Script 選「AI 額度」。

點小工具會打開 Scriptable 重新抓資料，就是「更新剩餘額度」按鈕的作用。

## 注意

- 金鑰存在 iOS 鑰匙圈（Keychain），只會送到 claude.ai 和 chatgpt.com。
- 用的是官網自己用的非公開 API，官方改版就可能失效。
- ChatGPT 的 token 大約幾天到兩週會過期，失效時小工具會顯示「金鑰失效」，重新貼一次即可。
- 抓不到時會顯示上次的資料並標示「舊資料」。
- iOS 自己決定小工具多久更新一次（通常 15 分鐘以上），要即時就點一下。
