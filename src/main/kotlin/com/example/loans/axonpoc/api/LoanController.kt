package com.example.loans.axonpoc.api

import com.example.loans.axonpoc.command.*
import com.example.loans.axonpoc.query.*
import org.axonframework.commandhandling.gateway.CommandGateway
import org.axonframework.queryhandling.QueryGateway
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.math.BigDecimal
import java.util.UUID
import java.util.concurrent.CompletableFuture

/**
 * REST API — demonstrates the full CQRS flow:
 *   POST /loans          → Command → Aggregate → Event → Projection
 *   GET  /loans          → Query → Projection → Response
 *   GET  /loans/{id}     → Query → Projection → Response
 *   POST /loans/{id}/approve  → Command → Aggregate → Event → Projection
 *   POST /loans/{id}/reject   → Command → Aggregate → Event → Projection
 *   POST /loans/{id}/disburse → Command → Aggregate → Event → Projection
 */
@RestController
@RequestMapping("/api/loans")
class LoanController(
    private val commandGateway: CommandGateway,
    private val queryGateway: QueryGateway
) {

    // ---- Command Endpoints (Write Side) ----

    @PostMapping
    fun submitApplication(@RequestBody request: SubmitLoanRequest): ResponseEntity<Map<String, String>> {
        val loanId = UUID.randomUUID().toString()
        commandGateway.sendAndWait<Any>(
            SubmitLoanApplicationCommand(
                loanId = loanId,
                applicantName = request.applicantName,
                requestedAmount = request.requestedAmount,
                purpose = request.purpose
            )
        )
        return ResponseEntity.status(HttpStatus.CREATED)
            .body(mapOf("loanId" to loanId, "status" to "SUBMITTED"))
    }

    @PostMapping("/{loanId}/approve")
    fun approveLoan(
        @PathVariable loanId: String,
        @RequestBody request: ApproveLoanRequest
    ): ResponseEntity<Map<String, String>> {
        commandGateway.sendAndWait<Any>(
            ApproveLoanCommand(
                loanId = loanId,
                approvedAmount = request.approvedAmount,
                approvedBy = request.approvedBy
            )
        )
        return ResponseEntity.ok(mapOf("loanId" to loanId, "status" to "APPROVED"))
    }

    @PostMapping("/{loanId}/reject")
    fun rejectLoan(
        @PathVariable loanId: String,
        @RequestBody request: RejectLoanRequest
    ): ResponseEntity<Map<String, String>> {
        commandGateway.sendAndWait<Any>(
            RejectLoanCommand(
                loanId = loanId,
                reason = request.reason,
                rejectedBy = request.rejectedBy
            )
        )
        return ResponseEntity.ok(mapOf("loanId" to loanId, "status" to "REJECTED"))
    }

    @PostMapping("/{loanId}/disburse")
    fun disburseLoan(
        @PathVariable loanId: String,
        @RequestBody request: DisburseLoanRequest
    ): ResponseEntity<Map<String, String>> {
        commandGateway.sendAndWait<Any>(
            DisburseLoanCommand(
                loanId = loanId,
                disbursementAccount = request.disbursementAccount
            )
        )
        return ResponseEntity.ok(mapOf("loanId" to loanId, "status" to "DISBURSED"))
    }

    // ---- Query Endpoints (Read Side) ----

    @GetMapping
    fun getAllLoans(): CompletableFuture<List<LoanSummaryView>> {
        return queryGateway.query(
            FindAllLoansQuery(),
            org.axonframework.messaging.responsetypes.ResponseTypes
                .multipleInstancesOf(LoanSummaryView::class.java)
        )
    }

    @GetMapping("/{loanId}")
    fun getLoan(@PathVariable loanId: String): CompletableFuture<LoanSummaryView?> {
        return queryGateway.query(
            FindLoanByIdQuery(loanId),
            org.axonframework.messaging.responsetypes.ResponseTypes
                .optionalInstanceOf(LoanSummaryView::class.java)
        ).thenApply { it.orElse(null) }
    }

    @GetMapping("/status/{status}")
    fun getLoansByStatus(@PathVariable status: String): CompletableFuture<List<LoanSummaryView>> {
        return queryGateway.query(
            FindLoansByStatusQuery(status.uppercase()),
            org.axonframework.messaging.responsetypes.ResponseTypes
                .multipleInstancesOf(LoanSummaryView::class.java)
        )
    }
}

// ---- Request DTOs ----

data class SubmitLoanRequest(
    val applicantName: String,
    val requestedAmount: BigDecimal,
    val purpose: String
)

data class ApproveLoanRequest(
    val approvedAmount: BigDecimal,
    val approvedBy: String
)

data class RejectLoanRequest(
    val reason: String,
    val rejectedBy: String
)

data class DisburseLoanRequest(
    val disbursementAccount: String
)
