package com.sevenz.app.plugin;

import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import okhttp3.OkHttpClient;
import okhttp3.RequestBody;
import okhttp3.ResponseBody;

public class DownloaderImpl extends Downloader {
    private static DownloaderImpl instance;
    private final OkHttpClient client;

    private DownloaderImpl() {
        this.client = new OkHttpClient.Builder().build();
    }

    public static DownloaderImpl getInstance() {
        if (instance == null) instance = new DownloaderImpl();
        return instance;
    }

    @Override
    public Response execute(Request request) throws IOException, ReCaptchaException {
        okhttp3.Request.Builder requestBuilder = new okhttp3.Request.Builder()
            .method(request.httpMethod(), request.dataToSend() != null
                ? RequestBody.create(request.dataToSend()) : null)
            .url(request.url());

        for (Map.Entry<String, List<String>> entry : request.headers().entrySet()) {
            for (String value : entry.getValue()) {
                requestBuilder.addHeader(entry.getKey(), value);
            }
        }

        okhttp3.Response response = client.newCall(requestBuilder.build()).execute();
        ResponseBody body = response.body();
        String responseString = body != null ? body.string() : "";

        return new Response(
            response.code(),
            response.message(),
            response.headers().toMultimap(),
            responseString,
            response.request().url().toString()
        );
    }
}
