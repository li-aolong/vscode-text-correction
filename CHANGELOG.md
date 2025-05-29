# 更新日志 | Changelog

本文档记录了文本纠错扩展的所有重要更新和变更。

---

## [0.0.2] - 2025-05-29

### 改进 | Improvements
- **花费信息详细显示** | **Detailed Cost Information Display**
  - 在花费详情中新增输入花费和输出花费两项显示 | Added separate input cost and output cost items in cost details
  - 花费信息现在始终显示，即使花费为0 | Cost information now always displays, even when cost is 0

- **纠错进度详细提示** | **Detailed Correction Progress Tooltip**
  - 鼠标悬停在纠错进度上时显示详细信息 | Detailed information shown when hovering over correction progress
  - 包含总段落数、已纠正段落数、剩余段落数和完成百分比 | Includes total paragraphs, corrected paragraphs, remaining paragraphs, and completion percentage

- **取消纠错逻辑优化** | **Cancel Correction Logic Optimization**
  - 点击取消按钮后立即停止所有后台操作 | Immediately stop all background operations after clicking the cancel button
  - 保持界面状态不变，不再更新编辑器内容 | Maintain interface state and stop updating editor content

- **段落拒绝逻辑优化** | **Paragraph Rejection Logic Optimization**
  - 简化代码逻辑，移除冗余判断 | Simplified code logic, removed redundant conditions
  - 提高拒绝操作的稳定性和可靠性 | Improved stability and reliability of rejection operations

- **服务初始化逻辑优化** | **Service Initialization Logic Optimization**
  - 修复 DiffManager 初始化顺序问题 | Fixed DiffManager initialization sequence issue
  - 确保所有服务在使用前正确初始化 | Ensure all services are properly initialized before use

---

## [0.0.1] - 2025-05-25

### 初始版本 | Initial Release
- **全文纠错功能** | **Full Text Correction**
  - 支持按段落进行智能文本纠错
  - Support for intelligent text correction by paragraphs
  
- **可视化差异显示** | **Visual Diff Display**
  - 高亮显示原文与纠错结果的差异
  - Highlight differences between original text and correction results
  
- **逐项审核** | **Item-by-item Review**
  - 支持逐个段落接受或拒绝修改建议
  - Support for accepting or rejecting correction suggestions paragraph by paragraph
  
- **批量操作** | **Batch Operations**
  - 一键接受或拒绝所有修改
  - Accept or reject all changes with one click
  
- **成本控制** | **Cost Control**
  - 实时显示Token使用量和花费
  - Real-time display of token usage and costs
  
- **多文档支持** | **Multi-document Support**
  - 每个文档独立的纠错状态
  - Independent correction state for each document