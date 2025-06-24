# 更新日志 | Changelog

本文档记录了文本纠错扩展的所有重要更新和变更。

---

## [0.0.3] - 2024-06-24

### 新增功能 | New Features
- **选中文本纠错** | **Selected Text Correction**：支持只对选中的文本进行纠错，提供更灵活的编辑体验
- **快捷导航** | **Quick Navigation**：新增上一个/下一个修改位置的快捷导航功能，状态栏显示当前位置
- **时间统计功能** | **Time Statistics Feature**：完整的时间统计系统，包括操作耗时、处理速度和预估剩余时间
- **智能操作取消** | **Smart Operation Cancel**：优化取消机制，支持纠错过程中的实时取消操作

### 功能增强 | Feature Enhancements
- **右键菜单集成** | **Context Menu Integration**：选中文本后可通过右键菜单直接启动纠错功能
- **状态栏导航按钮** | **Status Bar Navigation Buttons**：新增◀▶导航按钮，快速跳转到上一个/下一个修改位置
- **导航进度显示** | **Navigation Progress Display**：状态栏显示当前修改位置（如"2/5"）

### 技术改进 | Technical Improvements
- **模块化架构重构** | **Modular Architecture Refactoring**：将功能拆分为专门的服务类，提高代码可维护性
  - 新增 `SelectionCorrectionService` 专门处理选中文本纠错
  - 新增 `TimeStatisticsService` 专门处理时间统计
  - 新增 `OperationLockService` 防止并发操作冲突
  - 新增 `ParagraphActionService` 处理段落级操作
- **操作锁机制** | **Operation Lock Mechanism**：防止并发操作冲突，确保数据一致性
- **智能diff算法** | **Smart Diff Algorithm**：优化字符级差异检测算法，提高准确性
- **状态管理优化** | **State Management Optimization**：改进多文档状态管理，支持并行处理
- **异步处理改进** | **Asynchronous Processing Improvements**：优化API调用和UI更新的异步处理

### 用户体验提升 | User Experience Improvements
- **详细时间信息显示** | **Detailed Time Information Display**：鼠标悬停时显示完整的时间统计信息
- **实时处理速度** | **Real-time Processing Speed**：显示平均处理速度（字符/秒或字符/分钟）
- **预估剩余时间** | **Estimated Time Remaining**：动态计算并显示预估完成时间
- **操作进度优化** | **Operation Progress Optimization**：更准确的进度显示和更友好的用户提示
- **多文档支持** | **Multi-document Support**：每个文档独立的纠错状态，支持多文档并行处理
- **智能提示增强** | **Enhanced Smart Tooltips**：更丰富的鼠标悬停提示信息

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