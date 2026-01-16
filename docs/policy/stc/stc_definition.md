# The STC way

## Code is cheap. Structure is not - Bootstrap efficient architecture for humans and AI.

---

## 1. What is STC

The name is inspired by the *Standard Template Construct* concept from the Warhammer 40k universe — a reproducible standard for building complex systems from known constructs.

Modern software is increasingly developed with the help of AI.
Most architectures are not designed for that.

They rely on implicit conventions, scattered knowledge, and runtime-only understanding.
This works for humans with full context — and breaks down quickly for machines.

**STC (Standard Template Construct) Workflow** is an approach to software development that treats **structure as a first-class artifact**.

STC Workflow defines how applications are **described, structured, and evolved**, rather than how they are implemented.

---

## 2. Goals and Non-Goals

### Goals

STC Workflow is primarily designed for **AI-assisted development**.

Core goals:

* reduce duplication of types and logic
* make system structure explicit and machine-readable
* enable planning through approved and proposed constructs
* allow systems to be understood without executing code

Additional goals:

* enable compatible, independently developed modules
* avoid vendor lock-in at the framework, runtime, or AI-provider level

---

### Non-Goals

STC Workflow does **not** aim to:

* be a universal framework
* provide a fixed set of components
* replace domain-specific modeling

STC defines **minimum structure**, not maximum abstraction.

---

## 3. STC Workflow

### 3.1 Core Principles

* **Structure before code**
  Types, schemas, and contracts are defined before implementations.

* **Explicit over implicit**
  Important concepts must be declared and registered.

* **Inspectable by default**
  Systems should be understandable without execution.

* **Composable systems**
  Applications are built by composing well-defined constructs.

* **AI-compatible by design**
  The workflow assumes AI participation from day one.

---

### 3.2 Registries as a Foundation

STC Workflow assumes that all significant constructs are represented in **registries**.

A registry can be a directory or any structured source of truth

What matters is that registries are:

* explicit
* discoverable
* machine-readable

---

### 3.3 Defining and Extending Constructs

STC Workflow does **not mandate a fixed set of entities**.

A project is expected to:

* define its own domain-specific constructs, or
* extend existing registries with compatible definitions

Concrete entities provided by frameworks are treated as **reference designs**, not requirements.

---

## 4. Registries

STC Workflow is built around three primary registries.

---

### 4.1 Types Registry

Contains:

* type definitions
* schemas
* contracts
* descriptors

Properties:

* no runtime behavior
* no concrete implementations
* defines shared language and compatibility

---

### 4.2 Components Registry

Contains:

* concrete implementations
* runtime logic
* executable constructs

Components:

* conform to the Types Registry
* remain replaceable where possible
* explicitly declare capabilities and boundaries

---

### 4.3 Policy Registry

Defines **how the system is built and evolved**.

May include:

* architectural rules
* conventions and constraints
* slash-commands and prompts for AI agents along with systemprompts and tools without AI vendor lock-in

The Policy Registry captures intent and philosophy.

---

## 5. Reference Implementation: STCjs

STCjs is an opinionated reference implementation of the STC Workflow for the TypeScript / JavaScript ecosystem.

It demonstrates one possible realization of the workflow through a concrete set of entities and runtime rules.

All concepts below belong to **STCjs**, not to STC Workflow itself.

Отлично. Ниже — **раздел 5 целиком**, уже в том стиле, который ты задал:

* кратко
* ясно
* без смешения с STC Workflow
* достаточно формально, чтобы быть спецификацией
* достаточно простым, чтобы читаться как reference

Это можно **прямо вставлять** в документ.

---

## 5. Reference Implementation: STCjs

STCjs is an opinionated reference implementation of the STC Workflow for the TypeScript / JavaScript ecosystem.

It provides a concrete set of entities and runtime rules that demonstrate how the workflow can be implemented in practice.
All concepts in this section are **implementation details of STCjs** and are not mandatory for other STC-based systems.

---

### 5.1 Core Concepts

#### 5.1.1 Brick

A **Brick** is the minimal declarative unit in STCjs.

A Brick:

* represents a single conceptual construct
* is identifiable and composable
* carries optional metadata
* does not imply state or behavior by default

In STCjs, many higher-level entities are represented as Bricks to enable:

* uniform composition
* registry-based inspection
* serialization and tooling support

---

#### 5.1.2 Disposable and Subscribable

STCjs treats resource management as an explicit concern.

* **Disposable** represents an entity that owns resources and must release them.
* **Subscribable** represents an entity that allows subscriptions and always implies ownership of resources.

Key rule:

> Every Subscribable in STCjs is also Disposable.

This ensures that:

* subscriptions are treated as resources
* cleanup is deterministic and explicit
* AI-generated code can reason about lifecycles safely

---

#### 5.1.3 Channel

A **Channel** is a universal communication primitive in STCjs.

A Channel:

* can transport events, messages, or binary data
* may be synchronous or asynchronous
* is both Disposable and Subscribable

Channels are used to:

* connect modules
* propagate events
* perform IO

The application IO surface (`app.io`) is implemented as a Channel.
All external interaction with the application flows through it.

---

#### 5.1.4 Collection and Descriptors

STCjs distinguishes between **stateless** and **stateful** constructs.

* Stateless constructs are preferred by default.
* Stateful constructs are introduced only when persistence or in-memory storage is required.

**Collection** represents a stateless interface for querying and organizing records.
**StatefulCollection** extends this model with in-memory or persistent storage.

For many entities, STCjs defines corresponding **descriptor types**.

Descriptors:

* contain minimal identifying information (e.g. id, type, title, optional metadata)
* are fully serializable
* are suitable for listings, inspection, and tooling

---

#### 5.1.5 Module

A **Module** represents a composable unit of application structure.

Modules:

* encapsulate functionality
* can be composed into larger modules
* may expose an API surface

A module is expected to:

* declare its dependencies explicitly
* avoid tight coupling to other modules
* remain runnable in isolation where possible

The root module defines the application.

---

### 5.2 Deterministic Mode

STCjs applications run in **deterministic mode by default**.

In deterministic mode:

* direct use of non-deterministic primitives is disallowed:

  * random number generators
  * timers
  * uncontrolled IO
* all external effects must pass through Channels

This design enables:

* record and replay of application behavior
* reproducible crashes
* time-travel debugging
* predictable execution for AI agents and automation

Non-deterministic behavior is possible, but only through **explicitly defined capabilities**, never implicitly.
