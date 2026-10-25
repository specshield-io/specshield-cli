package com.example.payments;

import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The NEW API (specs/target.yaml), written with no knowledge of old clients. */
@RestController
public class PaymentsController {

    public enum Status { PENDING, ACTIVE, FAILED }

    public record Payment(String id, Status paymentStatus, String amount) {}

    public record NewPayment(Integer amount, Status paymentStatus, String currency) {}

    public record Page(List<Payment> data, String next) {}

    @GetMapping("/payments")
    public Page list(@RequestParam(defaultValue = "20") int limit) {
        return new Page(List.of(new Payment("p1", Status.ACTIVE, "1250")), null);
    }

    @GetMapping("/payments/{id}")
    public Payment get(@PathVariable String id) {
        return new Payment(id, Status.ACTIVE, "1250");
    }

    @PostMapping("/payments")
    public ResponseEntity<Payment> create(@RequestBody NewPayment p) {
        if (p.currency() == null) throw new IllegalArgumentException("currency is required");
        return ResponseEntity.status(HttpStatus.CREATED)
                .header("X-Seen", p.paymentStatus() + "/" + p.currency())
                .body(new Payment("p2", p.paymentStatus(), String.valueOf(p.amount())));
    }
}
