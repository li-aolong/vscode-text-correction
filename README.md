# 智能文本纠错 | Text Correction

一个基于AI的智能文本纠错VS Code扩展，支持多种语言模型API，提供全面的文本纠错和差异对比功能。| An AI-powered intelligent text correction VS Code extension that supports multiple language model APIs, providing comprehensive text correction and diff comparison features.

项目地址：https://github.com/li-aolong/vscode-text-correction

## ✨ 主要特性 | Key Features

### 🔧 核心功能 | Core Features
- **全文纠错** | **Full Text Correction**：一键对整个文档进行智能纠错 | One-click intelligent correction for entire documents
- **选中纠错** | **Selected Text Correction**：支持只对选中的文本进行纠错 | Support correction of selected text only
- **段落级处理** | **Paragraph-level Processing**：按段落分别处理，提高准确性和效率 | Process text paragraph by paragraph for better accuracy and efficiency
- **可视化差异** | **Visual Diff**：高亮显示原文与纠错结果的差异 | Highlight differences between original text and correction results
- **逐项审核** | **Item-by-item Review**：支持逐个段落接受或拒绝修改建议 | Accept or reject correction suggestions paragraph by paragraph

### 🎛️ 操作控制 | Operation Control
- **批量操作** | **Batch Operations**：一键接受或拒绝所有修改 | Accept or reject all changes with one click
- **快捷导航** | **Quick Navigation**：通过状态栏快速跳转到上一个/下一个修改位置 | Quick jump to previous/next change locations via status bar
- **智能取消** | **Smart Cancel**：纠错过程中可随时取消操作 | Cancel correction operations at any time during the process
- **后台处理** | **Background Processing**：支持后台纠错，不影响其他工作 | Support background correction without affecting other work

### 💰 成本监控 | Cost Monitoring
- **实时费用统计** | **Real-time Cost Tracking**：显示Token使用量和实际花费 | Display token usage and actual spending
- **详细费用明细** | **Detailed Cost Breakdown**：分别显示输入和输出Token的费用 | Show separate costs for input and output tokens
- **多货币支持** | **Multi-currency Support**：支持美元和人民币显示 | Support USD and CNY currency display

### ⏱️ 时间统计 | Time Statistics
- **操作耗时追踪** | **Operation Time Tracking**：记录每次纠错操作的耗时 | Track time taken for each correction operation
- **处理速度分析** | **Processing Speed Analysis**：显示平均处理速度（字符/秒） | Show average processing speed (characters/second)
- **预估剩余时间** | **Estimated Time Remaining**：实时预估完成时间 | Real-time estimation of completion time

### 🔌 技术集成 | Technical Integration
- **OpenAI格式API支持** | **OpenAI Format API Support**：兼容OpenAI格式的API接口 | Compatible with OpenAI format API interfaces
- **状态栏集成** | **Status Bar Integration**：在状态栏显示纠错进度和操作按钮 | Display correction progress and action buttons in the status bar
- **CodeLens支持** | **CodeLens Support**：在编辑器中直接显示接受/拒绝按钮 | Show accept/reject buttons directly in the editor
- **多文档支持** | **Multi-document Support**：每个文档独立的纠错状态，支持同时处理多个文件 | Independent correction state for each document, support simultaneous processing of multiple files

## 🛠️ 扩展设置 | Extension Settings

### 必需配置 | Required Configuration
- `textCorrection.apiKey`: API密钥（必填）| API key (required)
- `textCorrection.baseUrl`: API服务地址 | API service URL (默认: https://api.openai.com/v1)
- `textCorrection.model`: 使用的模型名称（必填）| Model name to use (required)

### 高级配置 | Advanced Configuration
- `textCorrection.prompt`: 纠错提示词模板 | Correction prompt template
- `textCorrection.inputTokenPrice`: 输入Token价格（每百万Token）| Input token price (per million tokens) (默认: 2)
- `textCorrection.outputTokenPrice`: 输出Token价格（每百万Token）| Output token price (per million tokens) (默认: 8)
- `textCorrection.currency`: 货币单位 | Currency unit (美元/元) (默认: 元)

## 📋 使用方法 | How to Use

### 基本操作 | Basic Operations
1. **开始纠错** | **Start Correction**：
   - 全文纠错：状态栏点击 `全文纠错` 按钮
   - 选中纠错：选择文本后，右键菜单选择 `Text Correction: 选中纠错`
   
2. **查看差异** | **View Differences**：纠错完成后，修改的段落会高亮显示，红色表示删除，绿色表示添加

3. **审核修改** | **Review Changes**：
   - **接受修改** | **Accept Changes**：点击段落旁的 ✅ 按钮或点击状态栏的"全接受"按钮
   - **拒绝修改** | **Reject Changes**：点击段落旁的 ❌ 按钮或点击状态栏的"全拒绝"按钮

4. **导航功能** | **Navigation Features**：
   - 使用状态栏的 `◀` `▶` 按钮跳转到上一个/下一个修改位置
   - 状态栏显示当前位置（如 "2/5" 表示总共5处修改，当前是第2处）

5. **取消操作** | **Cancel Operation**：纠错过程中点击状态栏的"取消"按钮可立即停止操作

### 📖 命令参考 | Command Reference

| 命令 | 说明 | 快捷方式 |
|------|------|----------|
| `Text Correction: 全文纠错` | 对整个文档进行纠错 | 状态栏按钮 |
| `Text Correction: 选中纠错` | 对选中文本进行纠错 | 右键菜单 |
| `Text Correction: 取消纠错` | 取消当前纠错操作 | 状态栏按钮 |
| `Text Correction: 接受全部修改` | 接受所有修改建议 | 状态栏按钮 |
| `Text Correction: 拒绝全部修改` | 拒绝所有修改建议 | 状态栏按钮 |
| `Text Correction: 下一个修改` | 跳转到下一个修改位置 | 状态栏按钮 |
| `Text Correction: 上一个修改` | 跳转到上一个修改位置 | 状态栏按钮 |


### 状态栏功能 | Status Bar Features
- **纠错进度** | **Correction Progress**：显示当前纠错进度，鼠标悬停查看详细信息
- **费用统计** | **Cost Statistics**：实时显示Token使用量和花费，支持详细费用明细
- **时间统计** | **Time Statistics**：显示操作耗时、处理速度和预估剩余时间
- **操作按钮** | **Action Buttons**：提供取消、接受全部、拒绝全部、导航等快捷操作

## 🔧 故障排除 | Troubleshooting

### 常见问题 | Common Issues

**Q: API 调用失败？**
A: 
- 验证 API 密钥是否有效
- 检查网络连接是否正常
- 确认 API 地址是否正确

**Q: 费用统计不准确？**
A: 检查 Token 价格配置是否正确，价格应为每百万 Token 的费用

**Q: 纠错速度很慢？**
A: 这取决于 API 服务的响应速度和文档大小，可以尝试分段纠错

### 获取帮助 | Get Help
- 项目 Issues: https://github.com/li-aolong/vscode-text-correction/issues
- 功能建议: 在 GitHub 上提交 Feature Request
- 使用问题: 查看项目文档或提交 Issue

## 🎯 适用场景 | Use Cases

- **学术论文校对** | **Academic paper proofreading**：智能检测和纠正语法、拼写错误
- **技术文档优化** | **Technical documentation optimization**：提升文档的专业性和可读性
- **商务邮件润色** | **Business email polishing**：确保商务沟通的准确性和专业性
- **博客文章校对** | **Blog post proofreading**：提高文章质量，减少错误
- **营销文案优化** | **Marketing copy optimization**：优化营销内容的表达效果
- **翻译文本校对** | **Translation text proofreading**：修正翻译后的文本错误
- **README文件优化** | **README file optimization**：改善项目文档的质量
- **注释内容校对** | **Comment content proofreading**：提升代码注释的准确性

## 🔧 技术特性 | Technical Features

### 架构设计 | Architecture Design
- **模块化架构** | **Modular Architecture**：采用服务化架构，职责分离，易于维护
- **异步处理** | **Asynchronous Processing**：支持异步API调用，不阻塞用户界面
- **操作锁机制** | **Operation Lock Mechanism**：防止并发操作冲突，确保数据一致性
- **状态管理** | **State Management**：独立的编辑器状态管理，支持多文档并行处理

### 性能优化 | Performance Optimization
- **增量更新** | **Incremental Updates**：只更新变化的段落，提高处理效率
- **智能diff算法** | **Smart Diff Algorithm**：精确的字符级差异检测，准确显示修改内容
- **装饰缓存** | **Decoration Caching**：优化编辑器装饰渲染，提升用户体验
- **后台清理** | **Background Cleanup**：自动清理关闭编辑器的状态，节省内存

### 用户体验 | User Experience
- **实时反馈** | **Real-time Feedback**：进度提示、费用统计、时间预估等实时信息
- **智能提示** | **Smart Tooltips**：丰富的鼠标悬停提示，提供详细信息
- **快捷操作** | **Quick Actions**：状态栏集成的快捷按钮，提高操作效率
- **错误恢复** | **Error Recovery**：完善的错误处理和状态恢复机制

## 🚀 更新计划 | Roadmap

- [ ] **批量文件处理** | **Batch File Processing**：支持一次性处理多个文件
- [ ] **自定义规则** | **Custom Rules**：允许用户定义特定的纠错规则
- [ ] **历史记录** | **History Management**：保存和查看纠错历史记录
- [ ] **快捷键支持** | **Keyboard Shortcuts**：为常用操作设置快捷键
- [ ] **选中排除纠正** | **Exclude Selected Text from Correction**：选中部分文本后，排除这部分文本的纠正 | Select part of the text and exclude it from correction

---

**享受智能纠错带来的便利！| Enjoy the convenience of intelligent text correction!**
