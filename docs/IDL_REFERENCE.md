# Bridge IDL Reference (v1)

The Bridge Interface Definition Language: a small, deterministic contract
language that compiles to a canonical, hashable IR and generates code for
Go, Rust, TypeScript and Python.

This document describes the v1 grammar as implemented by `@bridge/core`
([ARCHITECTURE](./ARCHITECTURE.md) explains the pipeline behind it).

---

## File structure

A `.bridge` file contains, in order:

```
package <dotted.name>          ← exactly one, must be the first statement
import <dotted.package>        ← zero or more
<declarations>                 ← types, enums, unions, aliases, services, events
```

Comments:

- `///` **doc comments** — attach to the declaration or field below them and
  are preserved into the IR (`docs`), generated code doc blocks, and reports.
- `//` **plain comments** — allowed anywhere; they document the source file
  but are dropped by the compiler (they never reach the IR).

```bridge
package payments.v1    // ← dotted lowercase name; the last segment is the version

import payments.v1     // imports must come after package, before declarations
```

---

## Declarations

### `type` — struct

The workhorse: a named record with ordered fields.

```bridge
/// A monetary amount.
type Money {
    amount: int64                 // required
    currency: string @length(3)   // required + constraint
    reference: string?            // optional (see "Optional fields")
    note: string? = "created"     // optional with a default
    legacy_id: uuid @deprecated("superseded by id")
}
```

Field grammar:

```
field := doc* NAME ('?')? ':' type ('?')? constraint* ('=' default)?
```

- **Optional fields** — a `?` suffix on the field name or the type
  (`name: T?`). Canonical style (what `bridge fmt` emits) is the type
  suffix. Optional fields may be absent on the wire; generators map them to
  `*T` / `Option<T>` / `field?: T` / `field: T | None = None`.
- **Defaults** — `= <literal>` as written in the IDL (numbers, quoted
  strings, enum variant names). Defaults are carried verbatim in the IR.
- **Constraints** — zero or more, see below.
- **Deprecation** — `@deprecated` or `@deprecated("reason")`, placed after
  constraints. Surface in generated code and compat reports.

### Constraints

| Constraint | Applies to | Arguments | Meaning |
| --- | --- | --- | --- |
| `@min(n)` | numeric types¹ | number (negatives allowed) | value ≥ n |
| `@max(n)` | numeric types¹ | number | value ≤ n |
| `@length(n)` | `string` | 1 or 2 numbers | exact length, or `[min, max]` |
| `@email` | `string` | — | RFC-style email shape |
| `@url` | `string` | — | URL shape |
| `@pattern(re)` | `string` | regex string | user regex (⚠ not supported by the generated Rust validator — documented v1 limitation) |
| `@uuid` | `string` | — | UUID shape |

¹ numeric types: `int32`, `int64`, `uint32`, `uint64`, `float32`, `float64`,
`decimal`.

Applying a constraint to an unsupported type is a compile error
(`BR2013`). Every constraint accepts an optional custom message:
`@length(3, "ISO currency codes are 3 letters")` — the message travels in
the IR (`IRConstraint.message`) and into generated validators.

### `enum`

Open-by-evolution, closed-by-default: variants are SCREAMING_SNAKE_CASE
identifiers.

```bridge
enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED @deprecated("use COMPLETED")   // variants can be deprecated
}
```

Adding a variant is a **WARNING** in the compatibility engine (exhaustive
switches may not handle it); removing one is **BREAKING**.

### `union` — tagged sum

A tagged union with field-shaped variants:

```bridge
union PaymentMethod {
    card: CardPayment
    cash: CashPayment
}

type CardPayment { last4: string @length(4) }
type CashPayment { tendered: int64 }
```

Generated languages encode the tag (the variant name) alongside the payload;
variant addition is WARNING, removal BREAKING.

### `alias`

A transparent named type. Aliases participate in the compatibility engine as
their target (changing an alias target is BREAKING).

```bridge
alias RequestId = uuid
alias Amount = int64
```

### `service`

Named methods with struct-typed request and response. Both sides must be
**named struct references** — wrap primitives or lists in a struct first
(`BR2010`).

```bridge
service Payments {
    /// Creates and returns a payment.
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
```

Methods may be `@deprecated`. Adding a method is SAFE; removing or changing
a signature is BREAKING.

### `event`

A named payload for asynchronous contracts; struct-shaped fields. The
generators emit envelope helpers
(`{"event": "<Name>", "payload": {...}}`).

```bridge
event PaymentCaptured {
    payment_id: uuid
    amount: Money
}
```

Event field changes are reported by the compatibility engine nested under
`EventName.field` with kind `event-field-changed`.

---

## Primitives

The 13 primitive types and their mappings:

| Bridge | Go | Rust | TypeScript | Python | Note |
| --- | --- | --- | --- | --- | --- |
| `string` | `string` | `String` | `string` | `str` | |
| `bool` | `bool` | `bool` | `boolean` | `bool` | |
| `int32` | `int32` | `i32` | `number` | `int` | |
| `int64` | `int64` | `i64` | `number` | `int` | TS: values above 2^53 lose precision (documented in generated JSDoc) |
| `uint32` | `uint32` | `u32` | `number` | `int` | |
| `uint64` | `uint64` | `u64` | `number` | `int` | TS: same 2^53 caveat |
| `float32` | `float32` | `f32` | `number` | `float` | |
| `float64` | `float64` | `f64` | `number` | `float` | |
| `bytes` | `[]byte` | `Vec<u8>` | `Uint8Array` | `bytes` | base64 strings on the JSON wire (Python `from_dict`/`to_dict` convert) |
| `uuid` | `string` | `String` | `string` | `str` | rendered as strings everywhere |
| `timestamp` | `string` | `String` | `string` | `str` | RFC 3339 strings — no datetime dependency |
| `decimal` | `string` | `String` | `string` | `str` | strings avoid binary-float drift |
| `json` | `json.RawMessage` | `serde_json::Value` | `unknown` | `Any` | opaque pass-through |

## Composites

| Bridge | Go | Rust | TypeScript | Python |
| --- | --- | --- | --- | --- |
| `list<T>` | `[]T` | `Vec<T>` | `T[]` | `list[T]` |
| `set<T>` | `Set[T]struct{}` wrapper | `BTreeSet<T>` | `Set<T>` | `set` |
| `map<K,V>` | `map[K]V` | `BTreeMap<K,V>` | `Record<K,V>` | `dict` |

- The **wire format of a set is always a JSON array**; generated helpers
  (`set_to_array` / `array_to_set` and language equivalents) convert.
- Rust uses `BTreeMap` for deterministic key ordering.
- **Map keys** must be hashable primitives: `string`, `bool`, `int32`,
  `int64`, `uint32`, `uint64`, `uuid` (`BR2011` otherwise).
- Optional list/set **elements** are not allowed (`list<string?>` →
  `BR2012`); wrap the whole collection instead: `list: string?`.

## Cross-package references

`import` another Bridge package and reference its types qualified:

```bridge
package orders.v1

import payments.v1

type Order {
    total: payments.v1.Money
}
```

When compiling, the imported package's compiled IR must be provided as a
dependency (`bridgeCompiler.compilePackage(..., dependencies)`; the CLI and
registry resolve this for you). In **generated code**, cross-package
references become *opaque aliases* of the raw JSON shape — Go
`json.RawMessage`, Rust `serde_json::Value`, TypeScript `unknown`, Python
`Any` — with a doc comment: *"imported from payments.v1; regenerate with
that package for full types."* They always compile and keep output
deterministic; the type-safe shape comes from generating the dependency's
package alongside your own.

## Naming conventions

Enforced as **warnings** (they never block compilation):

| Code | Rule | Example hint |
| --- | --- | --- |
| `BR2101` | Types are PascalCase | `PaymentStatus` |
| `BR2102` | Enum variants are SCREAMING_SNAKE_CASE | `PAYMENT_FAILED` |
| `BR2103` | Fields are snake_case | `customer_id` |

Field names double as JSON wire names — snake_case on the wire, camelCase /
PascalCase via generated accessors.

---

## Diagnostics

The compiler **never throws** on malformed input — it always returns
diagnostics. Each diagnostic carries `severity`, a stable `code`, a
`message`, `file`, 1-based `line`/`column` and an optional `hint`.
`formatDiagnostic` renders the canonical shape (this is what
`bridge validate` prints):

```
payment.bridge:8:13: error BR2001: Unknown type `mony`.

  8 |     amount: mony
    |             ^

  Did you mean `Money`?
```

### Diagnostic code families

| Family | Codes |
| --- | --- |
| Lexical | `BR1001` unexpected character · `BR1002` unterminated string · `BR1003` invalid escape |
| Syntax | `BR1004` (parser errors: unexpected token, unclosed block, malformed constraint args, …) |
| Semantic — declarations | `BR2001` unknown type · `BR2002` duplicate declaration · `BR2003` duplicate field/union member · `BR2004` duplicate enum variant · `BR2005` duplicate method · `BR2006` duplicate import · `BR2007` package statement problems · `BR2008` invalid dotted name · `BR2009` alias cycle · `BR2010` method signature must reference structs · `BR2011` invalid map key · `BR2012` optional collection element · `BR2013` constraint not applicable · `BR2014` unknown constraint · `BR2015` unknown imported package |
| Semantic — style (warnings) | `BR2101` · `BR2102` · `BR2103` (see Naming conventions) |
| Internal | `BR2999` (unexpected compiler failure — please report) |

Only `error`-severity diagnostics block compilation (`ok === false`);
`warning`s are advisory.

---

## Complete examples

### 1. Minimal

```bridge
package hello.v1

type Greeting {
    name: string @length(1)
    message: string?
}
```

### 2. Payments service

```bridge
package payments.v1

/// Money amount in the smallest currency unit.
type Money {
    amount: int64
    currency: string @length(3)
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

type GetPaymentRequest {
    id: uuid
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus
    created_at: timestamp
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
```

### 3. Everything at once

```bridge
package platform.v1

import payments.v1

alias RequestId = uuid

type Retry {
    attempts: int32 @min(0) @max(5)
    backoff_ms: int64 = 100
}

union Delivery {
    http: HttpDelivery
    queue: QueueDelivery
}

type HttpDelivery { url: string @url }
type QueueDelivery { topic: string @length(1) }

enum Encoding {
    JSON
    CBOR @deprecated("use JSON")
}

event ContractPublished {
    package_name: string @length(1)
    encoding: Encoding
    delivered_via: Delivery
    request_id: RequestId
    audit: map<string, string>
    tags: set<string>
    payment_total: payments.v1.Money
}

service Registry {
    Publish(PublishRequest) -> PublishReceipt
}

type PublishRequest {
    package_name: string @length(1)
    retries: Retry
}

type PublishReceipt {
    request_id: RequestId
    accepted_at: timestamp
}
```

---

## Where to next

- [QUICKSTART](./QUICKSTART.md) — install → contract → generate
- [COMPATIBILITY](./COMPATIBILITY.md) — what happens when this language evolves
- [ARCHITECTURE](./ARCHITECTURE.md) — how source text becomes IR and code
- [`examples/`](../examples) — every construct above, runnable
