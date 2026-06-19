package com.example.loans.axonpoc.query

import com.example.loans.axonpoc.command.*
import org.axonframework.eventhandling.EventHandler
import org.axonframework.queryhandling.QueryHandler
import org.springframework.stereotype.Component
import java.math.BigDecimal
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Query-side projection — builds a read model from events.
 *
 * In production, this would write to a dedicated read-model database
 * (DynamoDB, PostgreSQL, Elasticsearch). For the PoC, we use an
 * in-memory ConcurrentHashMap.
 *
 * Key insight: This projection is completely decoupled from the
 * command side. It can be rebuilt at any time by replaying events
 * from Axon Server.
 */
@Component
class LoanProjection {

    private val loans = ConcurrentHashMap<String, LoanSummaryView>()

    // ---- Event Handlers (update read model) ----

    @EventHandler
    fun on(event: LoanApplicationSubmittedEvent) {
        loans[event.loanId] = LoanSummaryView(
            loanId = event.loanId,
            applicantName = event.applicantName,
            requestedAmount = event.requestedAmount,
            status = "SUBMITTED",
            purpose = event.purpose,
            submittedAt = event.submittedAt
        )
    }

    @EventHandler
    fun on(event: LoanApprovedEvent) {
        loans.computeIfPresent(event.loanId) { _, view ->
            view.copy(
                status = "APPROVED",
                approvedAmount = event.approvedAmount,
                approvedBy = event.approvedBy,
                approvedAt = event.approvedAt
            )
        }
    }

    @EventHandler
    fun on(event: LoanRejectedEvent) {
        loans.computeIfPresent(event.loanId) { _, view ->
            view.copy(
                status = "REJECTED",
                rejectedReason = event.reason,
                rejectedBy = event.rejectedBy
            )
        }
    }

    @EventHandler
    fun on(event: LoanDisbursedEvent) {
        loans.computeIfPresent(event.loanId) { _, view ->
            view.copy(
                status = "DISBURSED",
                disbursedAt = event.disbursedAt
            )
        }
    }

    // ---- Query Handlers ----

    @QueryHandler
    fun handle(query: FindLoanByIdQuery): LoanSummaryView? {
        return loans[query.loanId]
    }

    @QueryHandler
    fun handle(query: FindAllLoansQuery): List<LoanSummaryView> {
        return loans.values.toList().sortedByDescending { it.submittedAt }
    }

    @QueryHandler
    fun handle(query: FindLoansByStatusQuery): List<LoanSummaryView> {
        return loans.values
            .filter { it.status == query.status }
            .sortedByDescending { it.submittedAt }
    }
}

// ---- Query Messages ----

data class FindLoanByIdQuery(val loanId: String)
data class FindAllLoansQuery(val limit: Int = 50)
data class FindLoansByStatusQuery(val status: String)

// ---- Read Model (View) ----

data class LoanSummaryView(
    val loanId: String,
    val applicantName: String,
    val requestedAmount: BigDecimal,
    val status: String,
    val purpose: String,
    val submittedAt: Instant,
    val approvedAmount: BigDecimal? = null,
    val approvedBy: String? = null,
    val approvedAt: Instant? = null,
    val rejectedReason: String? = null,
    val rejectedBy: String? = null,
    val disbursedAt: Instant? = null
)
