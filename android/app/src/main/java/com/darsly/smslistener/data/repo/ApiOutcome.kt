package com.darsly.smslistener.data.repo

import java.io.IOException
import retrofit2.HttpException

/** Coarse error categories — exactly the distinctions the UI needs to make. */
enum class ApiError {
    /** No connectivity, timeout, DNS/TLS failure. Always worth retrying. */
    NETWORK,

    /** OTP wrong, expired, or already used. */
    INVALID_CODE,

    /** Backend rate limiting (429). */
    RATE_LIMITED,

    /** Device token rejected — the device was revoked server-side. */
    UNAUTHORIZED,

    /** 5xx. */
    SERVER,

    UNKNOWN,
}

sealed interface ApiOutcome<out T> {
    data class Success<T>(val value: T) : ApiOutcome<T>

    data class Failure(val error: ApiError) : ApiOutcome<Nothing>
}

/**
 * Runs a suspending API call and classifies anything it throws. Nothing above
 * this line ever sees a raw [HttpException], and no exception escapes into a
 * worker or the UI.
 */
internal suspend fun <T> apiCall(block: suspend () -> T): ApiOutcome<T> =
    try {
        ApiOutcome.Success(block())
    } catch (e: HttpException) {
        ApiOutcome.Failure(
            when (e.code()) {
                400, 401 -> ApiError.INVALID_CODE
                403 -> ApiError.UNAUTHORIZED
                429 -> ApiError.RATE_LIMITED
                in 500..599 -> ApiError.SERVER
                else -> ApiError.UNKNOWN
            },
        )
    } catch (_: IOException) {
        ApiOutcome.Failure(ApiError.NETWORK)
    } catch (_: Exception) {
        ApiOutcome.Failure(ApiError.UNKNOWN)
    }
