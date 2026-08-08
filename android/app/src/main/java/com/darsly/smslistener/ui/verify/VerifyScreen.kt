package com.darsly.smslistener.ui.verify

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.darsly.smslistener.R

/**
 * Screen 1 — phone verification.
 *
 * Deliberately one field at a time: the number, then the code. Every state the
 * flow can be in (sending, sent, invalid, verified, offline, rate-limited) has a
 * visible message, so the user is never left guessing whether anything happened.
 */
@Composable
fun VerifyScreen(viewModel: VerifyViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = stringResource(R.string.verify_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.verify_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = state.phone,
            onValueChange = viewModel::onPhoneChange,
            label = { Text(stringResource(R.string.verify_phone_label)) },
            singleLine = true,
            enabled = state.step == VerifyStep.PHONE && !state.busy,
            isError = state.status == VerifyStatus.PHONE_INVALID,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )

        if (state.step == VerifyStep.PHONE) {
            Button(
                onClick = viewModel::sendOtp,
                enabled = state.canSendOtp,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.verify_send_otp))
            }
        } else {
            OutlinedTextField(
                value = state.code,
                onValueChange = viewModel::onCodeChange,
                label = { Text(stringResource(R.string.verify_code_label)) },
                singleLine = true,
                enabled = !state.busy,
                isError = state.status == VerifyStatus.INVALID_CODE,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = viewModel::verify,
                enabled = state.canVerify,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.verify_submit))
            }
            TextButton(onClick = viewModel::editPhone, enabled = !state.busy) {
                Text(stringResource(R.string.verify_edit_phone))
            }
        }

        StatusLine(state)
    }
}

@Composable
private fun StatusLine(state: VerifyUiState) {
    val message = state.status.messageRes() ?: return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (state.busy) {
            CircularProgressIndicator(
                modifier = Modifier
                    .size(20.dp)
                    .align(Alignment.Start),
                strokeWidth = 2.dp,
            )
        }
        Text(
            text = stringResource(message),
            style = MaterialTheme.typography.bodyMedium,
            color = if (state.status.isError()) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}

private fun VerifyStatus.messageRes(): Int? = when (this) {
    VerifyStatus.IDLE -> null
    VerifyStatus.SENDING_OTP -> R.string.verify_status_sending
    VerifyStatus.OTP_SENT -> R.string.verify_status_sent
    VerifyStatus.VERIFYING -> R.string.verify_status_verifying
    VerifyStatus.INVALID_CODE -> R.string.verify_status_invalid
    VerifyStatus.SUCCESS -> R.string.verify_status_success
    VerifyStatus.NETWORK_ERROR -> R.string.verify_status_network_error
    VerifyStatus.RATE_LIMITED -> R.string.verify_status_rate_limited
    VerifyStatus.SERVER_ERROR -> R.string.verify_status_network_error
    VerifyStatus.PHONE_INVALID -> R.string.verify_error_phone_invalid
}

private fun VerifyStatus.isError(): Boolean = when (this) {
    VerifyStatus.INVALID_CODE,
    VerifyStatus.NETWORK_ERROR,
    VerifyStatus.RATE_LIMITED,
    VerifyStatus.SERVER_ERROR,
    VerifyStatus.PHONE_INVALID,
    -> true
    else -> false
}
