package com.example.loans.axonpoc.command

import org.axonframework.commandhandling.CommandHandler
import org.axonframework.eventsourcing.EventSourcingHandler
import org.axonframework.modelling.command.AggregateIdentifier
import org.axonframework.modelling.command.AggregateLifecycle.apply
import org.axonframework.spring.stereotype.Aggregate
import java.math.BigDecimal

/**
 * Loan Aggregate — the command-side domain model.
 *
 * State is rebuilt from events (event sourcing). No database reads.
 * Commands are validated against current state, then events are emitted.
 */
@Aggregate
class LoanAggregate {

    @AggregateIdentifier
    private lateinit var loanId: String
    private lateinit var status: LoanStatus
    private lateinit var requestedAmount: BigDecimal
    private var approvedAmount: BigDecimal? = null

    // Required no-arg constructor for Axon
    constructor()

    /**
     * Command handler: Submit a new loan application.
     * This is the "creation" command — it initializes the aggregate.
     */
    @CommandHandler
    constructor(cmd: SubmitLoanApplicationCommand) {
        require(cmd.requestedAmount > BigDecimal.ZERO) {
            "Requested amount must be positive"
        }
        apply(
            LoanApplicationSubmittedEvent(
                loanId = cmd.loanId,
                applicantName = cmd.applicantName,
                requestedAmount = cmd.requestedAmount,
                purpose = cmd.purpose
            )
        )
    }

    @CommandHandler
    fun handle(cmd: ApproveLoanCommand) {
        check(status == LoanStatus.SUBMITTED) {
            "Can only approve a SUBMITTED loan (current: $status)"
        }
        require(cmd.approvedAmount > BigDecimal.ZERO) {
            "Approved amount must be positive"
        }
        apply(
            LoanApprovedEvent(
                loanId = loanId,
                approvedAmount = cmd.approvedAmount,
                approvedBy = cmd.approvedBy
            )
        )
    }

    @CommandHandler
    fun handle(cmd: RejectLoanCommand) {
        check(status == LoanStatus.SUBMITTED) {
            "Can only reject a SUBMITTED loan (current: $status)"
        }
        apply(
            LoanRejectedEvent(
                loanId = loanId,
                reason = cmd.reason,
                rejectedBy = cmd.rejectedBy
            )
        )
    }

    @CommandHandler
    fun handle(cmd: DisburseLoanCommand) {
        check(status == LoanStatus.APPROVED) {
            "Can only disburse an APPROVED loan (current: $status)"
        }
        apply(
            LoanDisbursedEvent(
                loanId = loanId,
                disbursementAccount = cmd.disbursementAccount
            )
        )
    }

    // ---- Event Sourcing Handlers (rebuild state from events) ----

    @EventSourcingHandler
    fun on(event: LoanApplicationSubmittedEvent) {
        loanId = event.loanId
        status = LoanStatus.SUBMITTED
        requestedAmount = event.requestedAmount
    }

    @EventSourcingHandler
    fun on(event: LoanApprovedEvent) {
        status = LoanStatus.APPROVED
        approvedAmount = event.approvedAmount
    }

    @EventSourcingHandler
    fun on(event: LoanRejectedEvent) {
        status = LoanStatus.REJECTED
    }

    @EventSourcingHandler
    fun on(event: LoanDisbursedEvent) {
        status = LoanStatus.DISBURSED
    }
}

enum class LoanStatus {
    SUBMITTED, APPROVED, REJECTED, DISBURSED
}
