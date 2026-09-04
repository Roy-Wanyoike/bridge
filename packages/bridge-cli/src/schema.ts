/**
 * Embedded starter contracts for `bridge init`.
 *
 * The payments starter mirrors `examples/payments` on main so a fresh
 * project is immediately compilable, publishable and generatable.
 */

export const PAYMENTS_STARTER = `// Bridge IDL example: a minimal payments contract.
// This file is the canonical example used in the README and docs.

package payments.v1

type Money {
    amount: int64
    currency: string @length(3)
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus
    created_at: timestamp
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

type GetPaymentRequest {
    id: uuid
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
`;

export const MINIMAL_STARTER = `// Bridge IDL — a minimal starter contract. Edit me!

package app.v1

/// A greeting request.
type HelloRequest {
    /// Who to greet.
    name: string @length(1)
}

/// A greeting reply.
type HelloReply {
    message: string
}

service Greeter {
    SayHello(HelloRequest) -> HelloReply
}
`;
