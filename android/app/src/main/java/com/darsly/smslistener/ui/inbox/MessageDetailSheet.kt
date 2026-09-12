package com.darsly.smslistener.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.darsly.smslistener.R
import com.darsly.smslistener.data.local.SmsMessageEntity
import com.darsly.smslistener.data.local.SyncStatus
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Everything the app knows about one message, in the order it happened:
 * what arrived, whether a rule claimed it, the exact body the server is sent,
 * and what the server said back.
 *
 * The payload block is not a description of the request — it is built from the
 * same six fields `SmsEventRequest` carries, so what is on screen is what goes
 * over the wire.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageDetailSheet(message: SmsMessageEntity, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = message.brand ?: message.sender.ifBlank { "—" },
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = stringResource(R.string.detail_from, message.sender.ifBlank { "—" }),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Section(stringResource(R.string.detail_content)) {
                Text(text = message.body, style = MaterialTheme.typography.bodyMedium)
            }

            Section(stringResource(R.string.detail_journey)) {
                Step(
                    label = stringResource(R.string.detail_step_received),
                    value = fullTimestamp(message.receivedAt),
                    done = true,
                )
                Step(
                    label = stringResource(R.string.detail_step_classified),
                    value = message.brand ?: stringResource(R.string.detail_unclassified),
                    done = message.brand != null,
                )
                Step(
                    label = stringResource(R.string.detail_step_sent),
                    value = when (message.syncStatus) {
                        SyncStatus.LOCAL_ONLY -> stringResource(R.string.detail_never_sent)
                        SyncStatus.PENDING -> stringResource(R.string.detail_queued, message.attemptCount)
                        SyncStatus.SYNCED -> message.lastAttemptAt?.let(::fullTimestamp) ?: "—"
                        SyncStatus.FAILED -> message.lastError ?: stringResource(R.string.status_failed)
                    },
                    done = message.syncStatus == SyncStatus.SYNCED,
                    failed = message.syncStatus == SyncStatus.FAILED,
                )
                Step(
                    label = stringResource(R.string.detail_step_verdict),
                    value = message.serverStatus ?: stringResource(R.string.detail_awaiting),
                    done = message.serverStatus != null,
                )
            }

            // Only worth showing for a message that is actually destined for the
            // backend — an unmatched one is never uploaded at all.
            if (message.syncStatus != SyncStatus.LOCAL_ONLY) {
                Section(stringResource(R.string.detail_payload)) {
                    Text(
                        text = payloadJson(message),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            fontWeight = FontWeight.Bold,
        )
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier.padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) { content() }
        }
    }
}

@Composable
private fun Step(label: String, value: String, done: Boolean, failed: Boolean = false) {
    val dot = when {
        failed -> MaterialTheme.colorScheme.error
        done -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.outline
    }
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Spacer(
            Modifier
                .padding(top = 6.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(dot),
        )
        Column(Modifier.weight(1f)) {
            Text(text = label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text = value, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

private val FULL: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM/yyyy · HH:mm:ss")

private fun fullTimestamp(epochMillis: Long): String =
    Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()).format(FULL)

/**
 * The request body verbatim — same fields, same names, same ISO-8601 UTC
 * timestamp the uploader sends.
 */
private fun payloadJson(m: SmsMessageEntity): String {
    val receivedAt = DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(m.receivedAt).atOffset(ZoneOffset.UTC))
    return buildString {
        appendLine("{")
        appendLine("""  "sender": "${m.sender.escapeJson()}",""")
        appendLine("""  "message": "${m.body.escapeJson()}",""")
        appendLine("""  "receivedAt": "$receivedAt",""")
        appendLine("""  "messageHash": "${m.messageHash}",""")
        appendLine("""  "simSlot": ${m.simSlot ?: "null"},""")
        appendLine("""  "subscriptionId": ${m.subscriptionId ?: "null"}""")
        append("}")
    }
}

private fun String.escapeJson() = replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
