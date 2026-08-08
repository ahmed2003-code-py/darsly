package com.darsly.smslistener.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.darsly.smslistener.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    viewModel: SettingsViewModel = viewModel(),
) {
    val unsynced by viewModel.unsyncedCount.collectAsStateWithLifecycle()
    val backendStatus by viewModel.backendStatus.collectAsStateWithLifecycle()
    val previewEnabled by viewModel.notificationPreview.collectAsStateWithLifecycle()
    val permissionGranted = remember { viewModel.smsPermissionGranted() }

    var confirmDelete by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.checkBackend() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    TextButton(onClick = onBack) { Text(stringResource(R.string.inbox_title)) }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            SectionHeader(stringResource(R.string.settings_section_device))
            InfoRow(stringResource(R.string.settings_phone), viewModel.verifiedPhone ?: "—")
            InfoRow(
                label = stringResource(R.string.settings_sms_permission),
                value = stringResource(
                    if (permissionGranted) R.string.settings_granted else R.string.settings_denied,
                ),
            )
            InfoRow(
                label = stringResource(R.string.settings_backend),
                value = stringResource(
                    when (backendStatus) {
                        BackendStatus.CONNECTED -> R.string.settings_backend_ok
                        BackendStatus.UNREACHABLE -> R.string.settings_backend_unreachable
                        else -> R.string.settings_backend_checking
                    },
                ),
            )
            InfoRow(stringResource(R.string.settings_pending_count), unsynced.toString())
            OutlinedButton(
                onClick = viewModel::syncNow,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.settings_sync_now))
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))

            SectionHeader(stringResource(R.string.settings_section_privacy))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.settings_show_preview),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    Text(
                        text = stringResource(R.string.settings_show_preview_desc),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = previewEnabled, onCheckedChange = viewModel::setNotificationPreview)
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))

            SectionHeader(stringResource(R.string.settings_section_danger))
            ActionRow(
                title = stringResource(R.string.settings_delete_messages),
                description = stringResource(R.string.settings_delete_messages_desc),
                onClick = { confirmDelete = true },
            )
            ActionRow(
                title = stringResource(R.string.settings_logout),
                description = stringResource(R.string.settings_logout_desc),
                onClick = { confirmLogout = true },
            )
        }
    }

    if (confirmDelete) {
        ConfirmDialog(
            message = stringResource(R.string.settings_delete_confirm),
            onConfirm = {
                viewModel.deleteLocalMessages()
                confirmDelete = false
            },
            onDismiss = { confirmDelete = false },
        )
    }

    if (confirmLogout) {
        ConfirmDialog(
            message = stringResource(R.string.settings_logout_confirm),
            onConfirm = {
                viewModel.unregister()
                confirmLogout = false
            },
            onDismiss = { confirmLogout = false },
        )
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
    )
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(text = label, style = MaterialTheme.typography.bodyLarge)
        Text(
            text = value,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ActionRow(title: String, description: String, onClick: () -> Unit) {
    Column(modifier = Modifier.padding(vertical = 8.dp)) {
        Text(text = description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Text(title)
        }
    }
}

@Composable
private fun ConfirmDialog(message: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text(stringResource(R.string.common_confirm)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
        },
    )
}
