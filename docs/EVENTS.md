# Event contracts

Bridge generates strongly-typed event publishers, consumers and a canonical
wire envelope from `event` declarations in the Bridge IDL.

```bridge
package store.v1

event OrderPlaced {
    order_id: uuid
    total_cents: int64
    currency: string @length(3)
}
```

## The wire envelope

Every generated language emits the identical CloudEvents-style envelope:

```json
{
  "specversion": "1.0",
  "id": "0f8c9a2e-...",
  "source": "//orders/checkout",
  "type": "store.v1.OrderPlaced",
  "time": "2026-09-04T12:00:00Z",
  "data": { "order_id": "...", "total_cents": 1999, "currency": "USD" }
}
```

| Field         | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `specversion` | Always `"1.0"` (CloudEvents 1.0 compatibility).               |
| `id`          | Caller-supplied unique id (generated code has no uuid RNG).   |
| `source`      | Caller-supplied logical origin, e.g. `//orders/checkout`.      |
| `type`        | `"<package>.<EventName>"` — the routing key everywhere.        |
| `time`        | Caller-supplied RFC3339 timestamp.                            |
| `data`        | The typed event payload (per-event `to_dict`/`Serialize`/…).  |

**Determinism rule**: `id`, `source` and `time` are always supplied by the
caller. Generated code contains no clocks and no uuid generation, so output
is byte-deterministic and envelope production is explicit at the call site.

## What gets generated

For each event, per language:

- a typed payload type (`OrderPlaced` struct/dataclass/interface) with the
  standard serialization pair (`Serialize`/`Deserialize`, `to_dict`/`from_dict`,
  `Serialize`/`Deserialize`, interface + JSON);
- the fully-qualified `type` constant (`OrderPlacedType`, `ORDER_PLACED_TYPE`, …);
- a typed publisher wrapper (`createOrderPlacedPublisher(publisher)`,
  `publish_order_placed(publisher, &event, &meta)`, …);
- per-event encode/decode helpers that validate `specversion` and `type`;
- a per-event handler registration on the shared dispatcher
  (`register_order_placed(dispatcher, handler)`, `onOrderPlaced(handler)`, …).

Shared machinery (once per package):

- `BridgeEventMeta` — `{ id, source, time }`.
- `BridgeEventEnvelope<T>` — the full envelope.
- `decodeBridgeEventEnvelope` / `decode_bridge_event_envelope` — shape validation.
- `EventPublisher` — the generic transport interface.
- `InMemoryEventBus` — publisher that fans out to in-process subscribers
  (ideal for tests; swap for a real broker in production).
- `BridgeEventDispatcher` — routes envelopes by `type` to registered handlers.

Language notes:

- **TypeScript**: async (`publish`/`dispatch` return `Promise<void>`),
  `dispatchJson(text)` helper included.
- **Python**: sync, `dispatch_json(text)` helper included; handlers receive
  decoded dataclasses.
- **Go**: `json.Marshal`-based envelope; handler interfaces per event.
- **Rust**: `serde_json::Value` payload plumbing; handlers receive decoded
  typed payloads; errors return `Result<(), String>`.

## Publishing and consuming

```python
# Python publisher
from store_v1 import OrderPlaced, BridgeEventMeta, InMemoryEventBus, publish_order_placed

bus = InMemoryEventBus()
meta = BridgeEventMeta(id="0f8c...", source="//orders/checkout", time="2026-09-04T12:00:00Z")
publish_order_placed(bus, OrderPlaced(order_id="...", total_cents=1999, currency="USD"), meta)
```

```rust
// Rust consumer
let mut dispatcher = BridgeEventDispatcher::new();
register_order_placed(&mut dispatcher, |payload, meta| {
    println!("order {} placed", payload.order_id);
    Ok(())
});
dispatcher.dispatch_json(raw_envelope_text)?;
```

Because the envelope is plain JSON with a fixed shape, any language (and any
broker — Kafka, NATS, SQS, RabbitMQ) can carry it without transformation: the
broker transports opaque envelopes, Bridge guarantees the schema inside.

## Testing

Every generated Rust crate ships `tests/roundtrip.rs` with dispatcher tests;
the generated Go module ships `roundtrip_test.go` with `httptest` coverage.
Cross-language envelope compatibility is proven in
[`scripts/verify-events-rpc.sh`](../scripts/verify-events-rpc.sh): a
Python-emitted envelope is decoded by the TypeScript generator output, and a
TypeScript client calls a Python server over real HTTP.
