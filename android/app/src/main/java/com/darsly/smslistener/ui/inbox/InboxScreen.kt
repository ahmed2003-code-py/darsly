package com.darsly.smslistener.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.darsly.smslistener.R
import com.darsly.smslistener.data.local.SmsMessageEntity
import com.darsly.smslistener.data.local.SyncStatus
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Screen 3 — the inbox. A status strip that answers "is this thing working?"
 * without opening anything, over a list of messages that each open to show
 * what arrived and what was sent on.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    onOpenSettings: () -> Unit,
    viewModel: InboxViewModel = viewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf<SmsMessageEntity?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.inbox_title)) },
                actions = {
                    TextButton(onClick = onOpenSettings) {
                        Text(stringResource(R.string.inbox_settings))
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            LinkStatusStrip(state)

            if (state.messages.isEmpty()) {
                EmptyState()
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(state.messages, key = { it.messageHash }) { message ->
                        MessageCard(message, onClick = { selected = message })
                    }
                }
            }
        }
    }

    selected?.let { message ->
        MessageDetailSheet(message = message, onDismiss = { selected = null })
    }
}

/**
 * The always-visible answer to "is it connected?". Colour carries the state so
 * it reads at a glance; the line under it says why, and when the backend last
 * accepted anything.
 */
@Composable
private fun LinkStatusStrip(state: InboxUiState) {
    val (color, labelRes) = when (state.link) {
        LinkState.CONNECTED -> MaterialTheme.colorScheme.primary to R.string.link_connected
        LinkState.PENDING -> MaterialTheme.colorScheme.tertiary to R.string.link_pending
        LinkState.NOT_ENROLLED -> MaterialTheme.colorScheme.error to R.string.link_not_enrolled
    }
    val detail = when (state.link) {
        LinkState.NOT_ENROLLED -> stringResource(R.string.link_not_enrolled_hint)
        LinkState.PENDING -> stringResource(R.string.link_pending_hint, state.unsyncedCount)
        LinkState.CONNECTED -> state.lastSyncedAt
            ?.let { stringResource(R.string.link_last_sync, formatTimestamp(it)) }
            ?: stringResource(R.string.link_waiting_first)
    }

    Surface(color = color.copy(alpha = 0.10f), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Spacer(Modifier.size(10.dp).clip(CircleShape).background(color))
            Column(Modifier.weight(1f)) {
                Text(
                    text = stringResource(labelRes),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = color,
                )
                Text(
                    text = detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            state.phone?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun MessageCard(message: SmsMessageEntity, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = message.brand ?: message.sender.ifBlank { "—" },
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Text(
                    text = formatTimestamp(message.receivedAt),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = message.body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SyncBadge(message.syncStatus)
                // The backend's own verdict, once it has one — the part that
                // actually says whether a transfer was recognised.
                message.serverStatus?.let { Chip(it, MaterialTheme.colorScheme.secondary) }
                Spacer(Modifier.weight(1f))
                Text(
                    text = stringResource(R.string.inbox_tap_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
        }
    }
}

@Composable
private fun SyncBadge(status: SyncStatus) {
    val (labelRes, color) = when (status) {
        SyncStatus.SYNCED -> R.string.status_synced to MaterialTheme.colorScheme.primary
        SyncStatus.PENDING -> R.string.status_pending to MaterialTheme.colorScheme.tertiary
        SyncStatus.FAILED -> R.string.status_failed to MaterialTheme.colorScheme.error
        SyncStatus.LOCAL_ONLY -> R.string.status_local to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Chip(stringResource(labelRes), color)
}

@Composable
private fun Chip(text: String, color: Color) {
    Surface(color = color.copy(alpha = 0.12f), shape = MaterialTheme.shapes.small) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = color,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun EmptyState(modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(32.dp),
        ) {
            Text(
                text = stringResource(R.string.inbox_empty_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.inbox_empty_body),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private val TIME_ONLY: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
private val DATE_AND_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("dd MMM HH:mm")

/** Today's messages show only the clock; older ones carry their date. */
private fun formatTimestamp(epochMillis: Long): String {
    val zone = ZoneId.systemDefault()
    val moment = Instant.ofEpochMilli(epochMillis).atZone(zone)
    val formatter = if (moment.toLocalDate() == LocalDate.now(zone)) TIME_ONLY else DATE_AND_TIME
    return moment.format(formatter)
}
