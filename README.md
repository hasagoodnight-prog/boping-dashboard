# AI 額度小工具

iPhone 主畫面小工具，同時顯示 **Claude**（5 小時／每週）和 **Codex** 的已用額度與重置倒數。

## 安裝

1. App Store 下載 **Scriptable**（免費）。
2. 在 Scriptable 新增腳本，把 `ai-usage-widget.js` 的內容整段貼上，命名為「AI 額度」。
3. 在 App 裡執行一次，選「登入 Claude」和「登入 ChatGPT（Codex）」，在跳出的畫面登入，完成後按「完成」關掉。
   - 建議用 **email 驗證碼**登入，Google 登入可能被擋。
   - 不用電腦、不用複製金鑰。真的登不進去，可以用「進階：手動貼金鑰」改貼 sessionKey / accessToken。
4. 回主畫面 → 長按 → 加入 Scriptable 小工具，選 **中** 尺寸 → 編輯小工具 → Script 選「AI 額度」。

點小工具會打開 Scriptable 重新抓資料，就是「更新剩餘額度」按鈕的作用。

## 注意

- 登入狀態存在 Scriptable 裡；手動貼的金鑰存在 iOS 鑰匙圈（Keychain）。資料只會送到 claude.ai 和 chatgpt.com。
- 用的是官網自己用的非公開 API，官方改版就可能失效。
- 登入過期時小工具會顯示「尚未登入」，打開 Scriptable 重新登入即可。
- 抓不到時會顯示上次的資料並標示「舊資料」。
- iOS 自己決定小工具多久更新一次（通常 15 分鐘以上），要即時就點一下。
