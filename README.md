# 智能文本纠错 | Text Correction

一个基于AI的智能文本纠错VS Code扩展，支持多种语言模型API，提供文本纠错和差异对比功能。| An AI-powered intelligent text correction VS Code extension that supports multiple language model APIs, providing real-time text correction and diff comparison features.

## ✨ 主要特性 | Key Features

- **全文纠错** | **Full Text Correction**：一键对整个文档进行智能纠错 | One-click intelligent correction for entire documents
- **选中纠错** | **Selected Text Correction**：支持只对选中的文本进行纠错 | Support correction of selected text only
- **段落级处理** | **Paragraph-level Processing**：按段落分别处理，提高准确性和效率 | Process text paragraph by paragraph for better accuracy and efficiency
- **可视化差异** | **Visual Diff**：高亮显示原文与纠错结果的差异 | Highlight differences between original text and correction results
- **逐项审核** | **Item-by-item Review**：支持逐个段落接受或拒绝修改建议 | Accept or reject correction suggestions paragraph by paragraph
- **批量操作** | **Batch Operations**：一键接受或拒绝所有修改 | Accept or reject all changes with one click
- **OpenAI格式API支持** | **OpenAI Format API Support**：兼容OpenAI格式的API接口 | Compatible with OpenAI format API interfaces
- **成本控制** | **Cost Control**：实时显示Token使用量、预估费用和实际花费 | Real-time display of token usage, estimated costs and actual spending
- **状态栏集成** | **Status Bar Integration**：在状态栏显示纠错进度和操作按钮 | Display correction progress and action buttons in the status bar
- **CodeLens支持** | **CodeLens Support**：在编辑器中直接显示接受/拒绝按钮 | Show accept/reject buttons directly in the editor
- **多文档支持** | **Multi-document Support**：每个文档独立的纠错状态，支持同时处理多个文件 | Independent correction state for each document, support simultaneous processing of multiple files

## 🛠️ 扩展设置 | Extension Settings

- `textCorrection.apiKey`: API密钥（必填）| API key (required)
- `textCorrection.baseUrl`: API服务地址 | API service URL
- `textCorrection.model`: 使用的模型名称（必填）| Model name to use (required)
- `textCorrection.prompt`: 纠错提示词模板 | Correction prompt template

## 📋 使用方法 | How to Use

### 基本操作 | Basic Operations
1. **开始纠错** | **Start Correction**：使用命令面板执行 `Text Correction: 全文纠错` 或点击状态栏的纠错按钮 | Use command palette to execute `Text Correction: 全文纠错` or click the correction button in status bar
2. **查看差异** | **View Differences**：纠错完成后，修改的段落会高亮显示 | After correction, modified paragraphs will be highlighted
3. **接受修改** | **Accept Changes**：点击段落旁的 ✅ 按钮或点击状态栏的"全接受"按钮 | Click the ✅ button next to paragraphs or click "Accept All" button in status bar
4. **拒绝修改** | **Reject Changes**：点击段落旁的 ❌ 按钮或点击状态栏的"全拒绝"按钮 | Click the ❌ button next to paragraphs or click "Reject All" button in status bar

## 🎯 适用场景 | Use Cases

- **学术论文校对** | **Academic paper proofreading**
- **技术文档优化** | **Technical documentation optimization**
- **商务邮件润色** | **Business email polishing**
- **博客文章校对** | **Blog post proofreading**
- **营销文案优化** | **Marketing copy optimization**
- **翻译文本校对** | **Translation text proofreading**
- **README文件优化** | **README file optimization**
- **注释内容校对** | **Comment content proofreading**

## � TODO List

- [ ] **上一个/下一个导航** | **Previous/Next Navigation**：快速跳转到上一个/下一个修改位置 | Quick jump to previous/next change locations
- [ ] **纠正时间显示** | **Correction Time Display**：显示每次纠错操作的耗时 | Display time taken for each correction operation
- [ ] **选中文本纠正** | **Selected Text Correction**：支持只对选中的文本进行纠错 | Support correction of selected text only
- [ ] **选中排除纠正** | **Exclude Selected Text from Correction**：选中部分文本后，排除这部分文本的纠正 | Select part of the text and exclude it from correction

---

**享受智能纠错带来的便利！| Enjoy the convenience of intelligent text correction!**
