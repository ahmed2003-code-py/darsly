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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.darsly.smslistener.R

/**
 * Screen 1 — enrollment. One field, one button.
 *
 * The admin generates a code for this handset's number and reads it out; typing it
 * here registers the device. Every state (working, wrong code, offline, rate
 * limited) has a visible message, so the user is never left guessing.
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
            text = stringResource(R.string.enroll_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.enroll_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = state.code,
            onValueChange = viewModel::onCodeChange,
            label = { Text(stringResource(R.string.enroll_code_label)) },
            placeholder = { Text("K7QM3XPD") },
            singleLine = true,
            enabled = !state.busy,
            isError = state.status == EnrollStatus.INVALID_CODE,
            textStyle = MaterialTheme.typography.headlineSmall.copy(
                fontFamily = FontFamily.Monospace,
                letterSpacing = 4.sp,
            ),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Text,
                capitalization = KeyboardCapitalization.Characters,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        Button(
            onClick = viewModel::submit,
            enabled = state.canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.enroll_submit))
        }

        StatusLine(state)
    }
}

@Composable
private fun StatusLine(state: EnrollUiState) {
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

private fun EnrollStatus.messageRes(): Int? = when (this) {
    EnrollStatus.IDLE -> null
    EnrollStatus.ENROLLING -> R.string.enroll_status_working
    EnrollStatus.SUCCESS -> R.string.enroll_status_success
    EnrollStatus.INVALID_CODE -> R.string.enroll_status_invalid
    EnrollStatus.NETWORK_ERROR -> R.string.enroll_status_network_error
    EnrollStatus.RATE_LIMITED -> R.string.enroll_status_rate_limited
    EnrollStatus.SERVER_ERROR -> R.string.enroll_status_server_error
}

private fun EnrollStatus.isError(): Boolean = when (this) {
    EnrollStatus.INVALID_CODE,
    EnrollStatus.NETWORK_ERROR,
    EnrollStatus.RATE_LIMITED,
    EnrollStatus.SERVER_ERROR,
    -> true
    else -> false
}
