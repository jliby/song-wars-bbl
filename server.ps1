$port = 8081
$root = "$PSScriptRoot"
$logFile = "$root\server.log"

"Server starting at $(Get-Date) on port $port" | Out-File $logFile

try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$port/")
    $listener.Start()
    "Listening on http://localhost:$port/" | Out-File $logFile -Append

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        "Request: $($request.Url.LocalPath)" | Out-File $logFile -Append

        $path = $root + $request.Url.LocalPath
        if ($request.Url.LocalPath -eq "/") { $path = "$root\index.html" }

        if (Test-Path $path) {
            try {
                $content = [System.IO.File]::ReadAllBytes($path)
                $response.ContentLength64 = $content.Length
                
                if ($path.EndsWith(".html")) { $response.ContentType = "text/html" }
                elseif ($path.EndsWith(".css")) { $response.ContentType = "text/css" }
                elseif ($path.EndsWith(".js")) { $response.ContentType = "application/javascript" }
                
                $response.OutputStream.Write($content, 0, $content.Length)
            }
            catch {
                $response.StatusCode = 500
                "Error serving file: $_" | Out-File $logFile -Append
            }
        }
        else {
            $response.StatusCode = 404
            "404 Not Found: $path" | Out-File $logFile -Append
        }
        $response.Close()
    }
}
catch {
    "Fatal Error: $_" | Out-File $logFile -Append
}
