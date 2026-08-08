package com.darsly.smslistener.data.remote

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

/**
 * The device-scoped Darsly API. Non-2xx responses surface as
 * `retrofit2.HttpException`, which callers map through
 * [com.darsly.smslistener.domain.SyncPolicy].
 */
interface DeviceApi {

    // ── Registration (no device token yet) ────────────────────────────────────

    @POST("device/auth/request-otp")
    suspend fun requestOtp(@Body body: RequestOtpRequest): RequestOtpResponse

    @POST("device/auth/verify-otp")
    suspend fun verifyOtp(@Body body: VerifyOtpRequest): DeviceTokensResponse

    @POST("device/auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): DeviceTokensResponse

    // ── Authenticated (Bearer device JWT, added by AuthInterceptor) ───────────

    @GET("device/me")
    suspend fun me(): DeviceMeResponse

    @POST("device/heartbeat")
    suspend fun heartbeat(): HeartbeatResponse

    @POST("device/unregister")
    suspend fun unregister(): OkResponse

    @GET("device/sms-rules")
    suspend fun smsRules(): List<SenderRuleDto>

    @POST("device/sms-events")
    suspend fun postSmsEvent(@Body body: SmsEventRequest): SmsEventResponse
}
