# 工程原理索引

CR agent 在报告 ISSUE 时，可引用以下原理作为"原理引用"字段的来源。引用格式：`原则名称 —《书名》(作者) 章节`。

---

## SOLID 原则

- **SRP (单一职责)** —《Clean Code》(Martin) Ch.10;《Code Complete》(McConnell) §7.2
- **OCP (开闭原则)** —《Clean Architecture》(Martin) Ch.8
- **LSP (里氏替换)** —《Clean Architecture》(Martin) Ch.9
- **ISP (接口隔离)** —《Clean Architecture》(Martin) Ch.10
- **DIP (依赖倒置)** —《Clean Architecture》(Martin) Ch.11

## 代码复杂度 & 模块设计

- **认知过载 (Cognitive Load)** —《A Philosophy of Software Design》(Ousterhout) Ch.2
- **变更传播 (Change Amplification)** —《A Philosophy of Software Design》(Ousterhout) Ch.2-3
- **深模块 (Deep Modules)** —《A Philosophy of Software Design》(Ousterhout) Ch.4
- **信息隐藏 (Information Hiding)** —《A Philosophy of Software Design》(Ousterhout) Ch.5
- **通用 vs 专用 (General vs Special Purpose)** —《A Philosophy of Software Design》(Ousterhout) Ch.6

## 重复 & 抽象

- **DRY (Don't Repeat Yourself)** —《The Pragmatic Programmer》(Hunt & Thomas) Tip 11
- **Rule of Three** —《Refactoring》(Fowler) Ch.3
- **提取方法 (Extract Method)** —《Refactoring》(Fowler) Ch.6
- **过早抽象 (Premature Abstraction)** —《A Philosophy of Software Design》(Ousterhout) Ch.6

## 代码坏味道

- **Long Method** —《Refactoring》(Fowler) Ch.3
- **Feature Envy** —《Refactoring》(Fowler) Ch.3
- **Shotgun Surgery** —《Refactoring》(Fowler) Ch.3
- **Divergent Change** —《Refactoring》(Fowler) Ch.3
- **Primitive Obsession** —《Refactoring》(Fowler) Ch.3

## 领域驱动设计

- **Ubiquitous Language** —《Domain-Driven Design》(Evans) Ch.2
- **Bounded Context** —《Domain-Driven Design》(Evans) Ch.14
- **Aggregate** —《Domain-Driven Design》(Evans) Ch.6

## 测试 & 可维护性

- **脆弱测试 (Fragile Tests)** —《xUnit Test Patterns》(Meszaros) Ch.16
- **Test Double 滥用** —《xUnit Test Patterns》(Meszaros) Ch.23
- **测试可读性** —《The Art of Unit Testing》(Osherove) Ch.7
- **遗留代码安全修改** —《Working Effectively with Legacy Code》(Feathers) Ch.1-4
- **接缝 (Seams)** —《Working Effectively with Legacy Code》(Feathers) Ch.4

## 并发 & 线程安全

- **共享可变状态** —《Java Concurrency in Practice》(Goetz) Ch.3
- **竞态条件 (Race Condition)** —《Java Concurrency in Practice》(Goetz) Ch.2
- **死锁 (Deadlock)** —《Java Concurrency in Practice》(Goetz) Ch.10
- **原子性违反 (Atomicity Violation)** —《Java Concurrency in Practice》(Goetz) Ch.4

## 安全

- **最小权限 (Least Privilege)** — OWASP Top 10; 《Security Engineering》(Anderson) Ch.4
- **输入验证 (Input Validation)** —《The Web Application Hacker's Handbook》(Stuttard & Pinto) Ch.2
- **纵深防御 (Defense in Depth)** — NIST SP 800-53
- **失败安全 (Fail Secure)** — OWASP Security Principles

## 架构 & 依赖

- **循环依赖 (Circular Dependency)** —《Clean Architecture》(Martin) Ch.14 (ADP)
- **稳定依赖原则 (SDP)** —《Clean Architecture》(Martin) Ch.14
- **分层架构 (Layered Architecture)** —《Patterns of Enterprise Application Architecture》(Fowler) Ch.1
- **六边形架构** —《Growing Object-Oriented Software》(Freeman & Pryce)

## 工程实践

- **童子军规则 (Boy Scout Rule)** —《Clean Code》(Martin) Ch.1
- **最小惊讶原则 (Principle of Least Astonishment)** —《Code Complete》(McConnell) §7.2
- **YAGNI** —《Extreme Programming Explained》(Beck) Ch.11
- **正交性 (Orthogonality)** —《The Pragmatic Programmer》(Hunt & Thomas) Ch.2
