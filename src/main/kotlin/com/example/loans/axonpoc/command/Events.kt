package com.example.loans.axonpoc.command

import java.math.BigDecimal
import java.time.Instant

/**
 * Events — immutable facts that have occurred.
 * These are stored in Axon Server's event store and replayed for projections.
 */

data class LoanApplicationSubmittedEvent(
    val loanId: String,
    val applicantName: String,
    val requestedAmount: BigDecimal,
    val purpose: String,
    val submittedAt: Instant = Instant.now()
)

data class LoanApprovedEvent(
    val loanId: String,
    val approvedAmount: BigDecimal,
    val approvedBy: String,
    val approvedAt: Instant = Instant.now()
)

data class LoanRejectedEvent(
    val loanId: String,
    val reason: String,
    val rejectedBy: String,
    val rejectedAt: Instant = Instant.now()
)

data class LoanDisbursedEvent(
    val loanId: String,
    val disbursementAccount: String,
    val disbursedAt: Instant = Instant.now()
)
