package com.darsly.smslistener.data.remote

import com.darsly.smslistener.data.security.SessionStore
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import retrofit2.Retrofit
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory

/**
 * Networking setup.
 *
 * Transport security is deliberately *stock*: OkHttp over the platform trust
 * store, HTTPS enforced by `network_security_config.xml` and a release-build
 * check on the configured URL. No custom TrustManager, no hostname-verifier
 * override, and no certificate pinning — pinning a payment-critical listener
 * would turn a routine certificate rotation into a silent outage that loses
 * events.
 *
 * There is no API key or shared secret in the APK. The app's only credential is
 * the device JWT it earns at runtime by proving control of the phone number.
 */
object ApiClient {

    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    val json: Json = Json {
        ignoreUnknownKeys = true // a new backend field must not break deployed devices
        explicitNulls = false // omit nulls rather than sending them
        encodeDefaults = true
    }

    fun create(baseUrl: String, session: SessionStore): DeviceApi {
        // A second, credential-free client for token refresh, so refreshing can
        // never recurse back through the authenticator.
        val refreshClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()

        val client = OkHttpClient.Builder()
            .addInterceptor(DeviceAuthInterceptor(session))
            .authenticator(DeviceTokenAuthenticator(baseUrl, session, json, refreshClient))
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory(JSON_MEDIA_TYPE))
            .build()
            .create(DeviceApi::class.java)
    }

    internal val JSON_MEDIA_TYPE = "application/json".toMediaType()

    internal fun isAuthEndpoint(path: String): Boolean = path.contains("/device/auth/")
}

/** Attaches the device access token to every authenticated call. */
internal class DeviceAuthInterceptor(private val session: SessionStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (ApiClient.isAuthEndpoint(request.url.encodedPath)) return chain.proceed(request)
        val token = session.accessToken() ?: return chain.proceed(request)
        return chain.proceed(
            request.newBuilder().header("Authorization", "Bearer $token").build(),
        )
    }
}

private sealed interface RefreshResult {
    data class Success(val tokens: DeviceTokensResponse) : RefreshResult

    /** The backend rejected the refresh token — this device is done. */
    data object Revoked : RefreshResult

    /** Network/5xx — the session may still be valid; do not destroy it. */
    data object Transient : RefreshResult
}

/**
 * Refreshes an expired device access token on a 401 and replays the request once.
 *
 * The distinction that matters for reliability: a *rejected* refresh token clears
 * the session (the device really was revoked), while a *failed* refresh attempt —
 * no signal, backend down — leaves the session untouched so queued messages are
 * still delivered when connectivity returns.
 */
internal class DeviceTokenAuthenticator(
    private val baseUrl: String,
    private val session: SessionStore,
    private val json: Json,
    private val client: OkHttpClient,
) : Authenticator {

    private val lock = Any()

    override fun authenticate(route: Route?, response: Response): Request? {
        if (ApiClient.isAuthEndpoint(response.request.url.encodedPath)) return null
        if (responseCount(response) >= 2) return null // one refresh attempt, then give up

        synchronized(lock) {
            val attempted = response.request.header("Authorization")
                ?.removePrefix("Bearer ")?.trim()
            val current = session.accessToken()

            // Another thread already refreshed while this request was in flight.
            if (current != null && current != attempted) {
                return response.request.newBuilder()
                    .header("Authorization", "Bearer $current")
                    .build()
            }

            val refreshToken = session.refreshToken() ?: return null
            return when (val result = refresh(refreshToken)) {
                is RefreshResult.Success -> {
                    session.updateTokens(result.tokens.accessToken, result.tokens.refreshToken)
                    response.request.newBuilder()
                        .header("Authorization", "Bearer ${result.tokens.accessToken}")
                        .build()
                }
                RefreshResult.Revoked -> {
                    session.clear()
                    null
                }
                RefreshResult.Transient -> null
            }
        }
    }

    private fun refresh(refreshToken: String): RefreshResult {
        val body = json.encodeToString(RefreshRequest.serializer(), RefreshRequest(refreshToken))
            .toRequestBody(ApiClient.JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + "/device/auth/refresh")
            .post(body)
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                when {
                    response.isSuccessful -> {
                        val payload = response.body?.string().orEmpty()
                        RefreshResult.Success(
                            json.decodeFromString(DeviceTokensResponse.serializer(), payload),
                        )
                    }
                    response.code == 401 || response.code == 403 -> RefreshResult.Revoked
                    else -> RefreshResult.Transient
                }
            }
        } catch (_: Exception) {
            // IO failure, or a malformed body from a captive portal — never a
            // reason to throw the session away.
            RefreshResult.Transient
        }
    }

    private fun responseCount(response: Response): Int {
        var count = 1
        var prior = response.priorResponse
        while (prior != null) {
            count++
            prior = prior.priorResponse
        }
        return count
    }
}
