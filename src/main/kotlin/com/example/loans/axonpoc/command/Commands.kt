package com.example.loans.axonpoc.command

import org.axonframework.modelling.command.TargetAggregateIdentifier
import java.math.BigDecimal
import java.util.UUID

/**
 * Commands — the "write" side intent messages.
 * Each command targets a specific Loan aggregate by ID.
 */

data class SubmitLoanApplicationCommand(
    @TargetAggregateIdentifier val loanId: String = UUID.randomUUID().toString(),
    val applicantName: String,
    val requestedAmount: BigDecimal,
    val purpose: String
)

data class ApproveLoanCommand(
    @TargetAggregateIdentifier val loanId: String,
    val approvedAmount: BigDecimal,
    val approvedBy: String
)

data class RejectLoanCommand(
    @TargetAggregateIdentifier val loanId: String,
    val reason: String,
    val rejectedBy: String
)

data class DisburseLoanCommand(
    @TargetAggregateIdentifier val loanId: String,
    val disbursementAccount: String
)
