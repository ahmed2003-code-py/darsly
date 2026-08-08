package com.darsly.smslistener.ui.verify

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.darsly.smslistener.data.repo.ApiError
import com.darsly.smslistener.data.repo.ApiOutcome
import com.darsly.smslistener.di.ServiceLocator
import com.darsly.smslistener.domain.PhoneNumbers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class VerifyStep { PHONE, CODE }

/** Every state the verification screen can show the user, explicitly. */
enum class VerifyStatus {
    IDLE,
    SENDING_OTP,
    OTP_SENT,
    VERIFYING,
    INVALID_CODE,
    SUCCESS,
    NETWORK_ERROR,
    RATE_LIMITED,
    SERVER_ERROR,
    PHONE_INVALID,
}

data class VerifyUiState(
    val phone: String = "",
    val code: String = "",
    val step: VerifyStep = VerifyStep.PHONE,
    val status: VerifyStatus = VerifyStatus.IDLE,
    val busy: Boolean = false,
) {
    val canSendOtp: Boolean get() = !busy && PhoneNumbers.isValid(phone)
    val canVerify: Boolean get() = !busy && code.trim().length >= 4
}

class VerifyViewModel(application: Application) : AndroidViewModel(application) {

    private val devices = ServiceLocator.from(application).deviceRepository

    private val _state = MutableStateFlow(VerifyUiState())
    val state: StateFlow<VerifyUiState> = _state.asStateFlow()

    fun onPhoneChange(value: String) {
        _state.update {
            it.copy(
                phone = value,
                status = if (it.status == VerifyStatus.PHONE_INVALID) VerifyStatus.IDLE else it.status,
            )
        }
    }

    fun onCodeChange(value: String) {
        _state.update {
            it.copy(
                code = value.filter { char -> char.isDigit() }.take(8),
                status = if (it.status == VerifyStatus.INVALID_CODE) VerifyStatus.OTP_SENT else it.status,
            )
        }
    }

    fun editPhone() {
        _state.update { it.copy(step = VerifyStep.PHONE, code = "", status = VerifyStatus.IDLE) }
    }

    fun sendOtp() {
        val phone = PhoneNumbers.sanitize(_state.value.phone)
        if (!PhoneNumbers.isValid(phone)) {
            _state.update { it.copy(status = VerifyStatus.PHONE_INVALID) }
            return
        }
        _state.update { it.copy(busy = true, status = VerifyStatus.SENDING_OTP) }
        viewModelScope.launch {
            when (val outcome = devices.requestOtp(phone)) {
                is ApiOutcome.Success -> _state.update {
                    it.copy(busy = false, step = VerifyStep.CODE, status = VerifyStatus.OTP_SENT)
                }
                is ApiOutcome.Failure -> _state.update {
                    it.copy(busy = false, status = outcome.error.toStatus())
                }
            }
        }
    }

    fun verify() {
        val current = _state.value
        if (!current.canVerify) return
        _state.update { it.copy(busy = true, status = VerifyStatus.VERIFYING) }
        viewModelScope.launch {
            val phone = PhoneNumbers.sanitize(current.phone)
            when (val outcome = devices.verifyOtp(phone, current.code)) {
                // On success the session store flips `registered`, which routes the
                // app forward; the state update is only so the user sees confirmation.
                is ApiOutcome.Success -> _state.update {
                    it.copy(busy = false, status = VerifyStatus.SUCCESS)
                }
                is ApiOutcome.Failure -> _state.update {
                    it.copy(busy = false, status = outcome.error.toStatus())
                }
            }
        }
    }

    private fun ApiError.toStatus(): VerifyStatus = when (this) {
        ApiError.NETWORK -> VerifyStatus.NETWORK_ERROR
        ApiError.INVALID_CODE -> VerifyStatus.INVALID_CODE
        ApiError.RATE_LIMITED -> VerifyStatus.RATE_LIMITED
        ApiError.UNAUTHORIZED -> VerifyStatus.INVALID_CODE
        ApiError.SERVER -> VerifyStatus.SERVER_ERROR
        ApiError.UNKNOWN -> VerifyStatus.SERVER_ERROR
    }
}
