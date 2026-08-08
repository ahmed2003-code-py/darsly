package com.darsly.smslistener.ui.verify

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.darsly.smslistener.data.repo.ApiError
import com.darsly.smslistener.data.repo.ApiOutcome
import com.darsly.smslistener.di.ServiceLocator
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Every state the enrollment screen can show, explicitly. */
enum class EnrollStatus {
    IDLE,
    ENROLLING,
    SUCCESS,
    INVALID_CODE,
    NETWORK_ERROR,
    RATE_LIMITED,
    SERVER_ERROR,
}

data class EnrollUiState(
    val code: String = "",
    val status: EnrollStatus = EnrollStatus.IDLE,
    val busy: Boolean = false,
) {
    val canSubmit: Boolean get() = !busy && code.length == CODE_LENGTH

    companion object {
        /** Two groups of four, e.g. K7QM-3XPD. */
        const val CODE_LENGTH = 8
    }
}

/**
 * Enrollment is a single step: type the code an admin generated, and the device is
 * registered. There is deliberately no phone-number field — the number is bound to
 * the code on the server, so a handset can never enroll itself under someone
 * else's number.
 */
class VerifyViewModel(application: Application) : AndroidViewModel(application) {

    private val devices = ServiceLocator.from(application).deviceRepository

    private val _state = MutableStateFlow(EnrollUiState())
    val state: StateFlow<EnrollUiState> = _state.asStateFlow()

    fun onCodeChange(value: String) {
        // Accept it however it is typed — spaces, dashes, lower case.
        val cleaned = value.uppercase()
            .filter { it.isLetterOrDigit() }
            .take(EnrollUiState.CODE_LENGTH)
        _state.update {
            it.copy(
                code = cleaned,
                status = if (it.status == EnrollStatus.INVALID_CODE) EnrollStatus.IDLE else it.status,
            )
        }
    }

    fun submit() {
        val current = _state.value
        if (!current.canSubmit) return
        _state.update { it.copy(busy = true, status = EnrollStatus.ENROLLING) }
        viewModelScope.launch {
            when (val outcome = devices.enroll(current.code)) {
                // On success the session store flips `registered`, which routes the
                // app forward; this update only lets the user see confirmation.
                is ApiOutcome.Success -> _state.update {
                    it.copy(busy = false, status = EnrollStatus.SUCCESS)
                }
                is ApiOutcome.Failure -> _state.update {
                    it.copy(busy = false, status = outcome.error.toStatus())
                }
            }
        }
    }

    private fun ApiError.toStatus(): EnrollStatus = when (this) {
        ApiError.NETWORK -> EnrollStatus.NETWORK_ERROR
        ApiError.INVALID_CODE, ApiError.UNAUTHORIZED -> EnrollStatus.INVALID_CODE
        ApiError.RATE_LIMITED -> EnrollStatus.RATE_LIMITED
        ApiError.SERVER, ApiError.UNKNOWN -> EnrollStatus.SERVER_ERROR
    }
}
