package com.example.payments;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * The controller speaks API 2.0.0 only. With the generated layer, a client
 * that sends no X-API-Version (or 1.0.0) must see exactly the 1.0.0 shapes of
 * specs/base.yaml, and a 2.0.0 client must see the controller's output as is.
 */
@SpringBootTest
@AutoConfigureMockMvc
class CompatLayerTest {

    @Autowired MockMvc mvc;

    @Test
    void oldClientGetsOldPaymentShape() throws Exception {
        mvc.perform(get("/payments/p1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value("p1"))
                .andExpect(jsonPath("$.status").value("ENABLED"))       // renamed back, enum value mapped back
                .andExpect(jsonPath("$.paymentStatus").doesNotExist())
                .andExpect(jsonPath("$.amount").value(1250))            // string → integer
                .andExpect(jsonPath("$.amount").isNumber());
    }

    @Test
    void explicitOldVersionIsTheSameAsNoHeader() throws Exception {
        mvc.perform(get("/payments/p1").header("X-API-Version", "1.0.0"))
                .andExpect(jsonPath("$.status").value("ENABLED"))
                .andExpect(jsonPath("$.amount").isNumber());
    }

    @Test
    void newClientGetsNewShapeUntouched() throws Exception {
        mvc.perform(get("/payments/p1").header("X-API-Version", "2.0.0"))
                .andExpect(jsonPath("$.paymentStatus").value("ACTIVE"))
                .andExpect(jsonPath("$.status").doesNotExist())
                .andExpect(jsonPath("$.amount").value("1250"));
    }

    @Test
    void oldClientGetsAPlainListBack() throws Exception {
        mvc.perform(get("/payments"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray())
                .andExpect(jsonPath("$[0].status").value("ENABLED"))
                .andExpect(jsonPath("$[0].amount").isNumber());
        mvc.perform(get("/payments").header("X-API-Version", "2.0.0"))
                .andExpect(jsonPath("$.data[0].paymentStatus").value("ACTIVE"));
    }

    @Test
    void oldRequestIsUpgradedAndAnsweredInTheOldShape() throws Exception {
        mvc.perform(post("/payments").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"amount\": 5, \"status\": \"ENABLED\"}"))
                .andExpect(status().isCreated())
                .andExpect(header().string("X-Seen", "ACTIVE/EUR"))     // renamed, value mapped, default added
                .andExpect(jsonPath("$.status").value("ENABLED"))
                .andExpect(jsonPath("$.amount").value(5));
    }

    @Test
    void newRequestPassesThrough() throws Exception {
        mvc.perform(post("/payments").header("X-API-Version", "2.0.0").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"amount\": 7, \"paymentStatus\": \"PENDING\", \"currency\": \"USD\"}"))
                .andExpect(status().isCreated())
                .andExpect(header().string("X-Seen", "PENDING/USD"))
                .andExpect(jsonPath("$.paymentStatus").value("PENDING"))
                .andExpect(jsonPath("$.amount").value("7"));
    }
}
