package com.akhil.promptflow

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.akhil.promptflow.core.Api
import com.akhil.promptflow.core.Dictation
import com.akhil.promptflow.core.Store

class PromptFlowApp : Application() {
    lateinit var store: Store
        private set
    lateinit var api: Api
        private set
    lateinit var dictation: Dictation
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        store = Store(this)
        api = Api(store)
        dictation = Dictation(api, store)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_LISTENING, getString(R.string.listening_channel), NotificationManager.IMPORTANCE_LOW),
        )
    }

    companion object {
        const val CHANNEL_LISTENING = "listening"
        lateinit var instance: PromptFlowApp
            private set
    }
}
