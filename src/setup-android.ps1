param(
    [switch]$AcceptSdkLicense,
    [switch]$EnableHypervisor
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Expand-VerifiedZip($Archive, $Destination) {
    $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
    if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw 'Windows tar.exe is required for Android setup.' }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    & $tar -xf $Archive -C $Destination
    if ($LASTEXITCODE -ne 0) { throw "Could not extract the verified ZIP (tar exit code $LASTEXITCODE)." }
}

function Get-VerifiedArchive($Uri, $Sha256, $Destination) {
    Write-Host "Downloading $([IO.Path]::GetFileName(([Uri]$Uri).AbsolutePath))..."
    $curl = Join-Path $env:SystemRoot 'System32/curl.exe'
    if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'Windows curl.exe is required for Android setup.' }
    & $curl --fail --location --show-error --progress-bar --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 900 --output $Destination $Uri
    if ($LASTEXITCODE -ne 0) { throw "Download failed (curl exit code $LASTEXITCODE)." }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Sha256) {
        throw 'Download verification failed (SHA-256 mismatch).'
    }
}

function Find-Java21($PrivateJava) {
    $fromPath = Get-Command java.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @($PrivateJava, $env:JAVA_HOME)
    if ($fromPath) { $candidates += Split-Path (Split-Path $fromPath.Source) }
    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        $java = Join-Path $candidate 'bin/java.exe'
        if (-not (Test-Path -LiteralPath $java -PathType Leaf)) { continue }
        $oldPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $version = (& $java -version 2>&1 | Out-String)
        } finally {
            $ErrorActionPreference = $oldPreference
        }
        if ($version -match 'version "(\d+)' -and [int]$Matches[1] -ge 21) { return $candidate }
    }
    return $null
}

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'Profile Desk Android setup supports Windows x64.'
}

Write-Host 'Profile Desk Android setup'
if (-not $AcceptSdkLicense) { throw 'Accept the Android SDK License Agreement in Profile Desk before installing.' }

$sdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk'
New-Item -ItemType Directory -Path $sdk -Force | Out-Null
$sdk = (Resolve-Path -LiteralPath $sdk).Path
$lockFile = Join-Path $sdk '.profile-desk-setup.lock'
try {
    $lock = [IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    throw 'Another setup is running or the SDK directory is locked.'
}
$staging = $null
try {
    $staging = Join-Path $sdk ('.profile-desk-stage-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    $privateJava = Join-Path $sdk 'profile-desk-java'
    $javaHome = Find-Java21 $privateJava
    if (-not $javaHome) {
        if (Test-Path -LiteralPath $privateJava) { throw 'The private Java directory exists but its runtime failed verification.' }
        $archive = Join-Path $staging 'java.zip'
        Get-VerifiedArchive 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip' '2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628' $archive
        $unpack = Join-Path $staging 'java'
        Expand-VerifiedZip $archive $unpack
        $javaDirs = @(Get-ChildItem -LiteralPath $unpack -Directory | Where-Object {
            Test-Path -LiteralPath (Join-Path $_.FullName 'bin/java.exe') -PathType Leaf
        })
        if ($javaDirs.Count -ne 1) { throw 'Unexpected Java archive layout.' }
        [IO.Directory]::Move($javaDirs[0].FullName, $privateJava)
        $javaHome = $privateJava
    }
    $env:JAVA_HOME = $javaHome
    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk

    $toolsRoot = Join-Path $sdk 'cmdline-tools'
    $tools = Join-Path $toolsRoot 'latest'
    $manager = Join-Path $tools 'bin/sdkmanager.bat'
    $avdManager = Join-Path $tools 'bin/avdmanager.bat'
    if (-not ((Test-Path -LiteralPath $manager -PathType Leaf) -and (Test-Path -LiteralPath $avdManager -PathType Leaf))) {
        if (Test-Path -LiteralPath $tools) { throw 'Repair the incomplete cmdline-tools/latest directory before retrying.' }
        $archive = Join-Path $staging 'sdk-tools.zip'
        Get-VerifiedArchive 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a' $archive
        $unpack = Join-Path $staging 'tools'
        Expand-VerifiedZip $archive $unpack
        $unpackedTools = Join-Path $unpack 'cmdline-tools'
        if (-not (Test-Path -LiteralPath (Join-Path $unpackedTools 'bin/sdkmanager.bat') -PathType Leaf)) {
            throw 'Unexpected Android command-line tools archive layout.'
        }
        New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
        [IO.Directory]::Move($unpackedTools, $tools)
    }

    $image = 'system-images;android-35;google_apis_playstore;x86_64'
    Write-Host 'Installing Android Emulator, Platform-Tools and the Android 35 Google Play image...'
    1..16 | ForEach-Object { 'y' } | & $manager "--sdk_root=$sdk" --install 'platform-tools' 'emulator' $image
    if ($LASTEXITCODE -ne 0) { throw 'sdkmanager did not complete. Check the messages above and rerun setup.' }

    $emulator = Join-Path $sdk 'emulator/emulator.exe'
    $adb = Join-Path $sdk 'platform-tools/adb.exe'
    if (-not ((Test-Path -LiteralPath $emulator -PathType Leaf) -and (Test-Path -LiteralPath $adb -PathType Leaf))) {
        throw 'Emulator or Platform-Tools are missing after installation.'
    }
    $avd = 'Profile_Desk_Pixel'
    $devices = @(& $emulator -list-avds)
    if ($LASTEXITCODE -ne 0) { throw 'The emulator could not list devices.' }
    if ($avd -notin $devices) {
        'no' | & $avdManager create avd --name $avd --package $image --device pixel_7
        if ($LASTEXITCODE -ne 0) { throw 'avdmanager could not create the test phone.' }
        $devices = @(& $emulator -list-avds)
        if ($LASTEXITCODE -ne 0 -or $avd -notin $devices) { throw 'The new virtual device could not be verified.' }
    }

    Set-Content -LiteralPath (Join-Path $sdk '.profile-desk-android-ready') -Value $avd -Encoding ascii
    Write-Host "Android SDK and $avd are ready. Return to Profile Desk and click Refresh devices."
    $feature = Get-CimInstance Win32_OptionalFeature -Filter "Name='HypervisorPlatform'" -ErrorAction SilentlyContinue
    if ($feature -and $feature.InstallState -ne 1) {
        Write-Host 'Windows Hypervisor Platform is disabled. Enabling it may require a restart.'
        if ($EnableHypervisor) {
            Write-Host 'Requesting Windows approval to enable Hypervisor Platform…'
            try {
                $dism = Join-Path $env:SystemRoot 'System32/dism.exe'
                $task = Start-Process -FilePath $dism -Verb RunAs -ArgumentList '/Online','/Enable-Feature','/FeatureName:HypervisorPlatform','/All','/NoRestart' -WindowStyle Hidden -Wait -PassThru
                if ($task.ExitCode -in @(0, 3010)) {
                    $acceleration = (& $emulator -accel-check | Out-String)
                    if ($LASTEXITCODE -eq 0 -and $acceleration -match '(?m)^accel:\s*0(?:\s|$)') {
                        Write-Host 'Windows Hypervisor Platform is usable. You can open the emulator now.'
                    } else {
                        Write-Host 'Restart Windows before launching the emulator.'
                        Write-Host '[PROFILE_DESK_RESTART_REQUIRED]'
                    }
                } else {
                    Write-Warning "Windows feature setup returned $($task.ExitCode)."
                }
            } catch {
                Write-Warning 'Windows feature setup did not run. You can enable Windows Hypervisor Platform in Optional Features.'
            }
        } else {
            Write-Host 'Enable Windows Hypervisor Platform in Optional Features before starting the emulator.'
        }
    }
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) {
        $resolvedStage = (Resolve-Path -LiteralPath $staging).Path
        if ([IO.Path]::GetDirectoryName($resolvedStage) -eq $sdk -and [IO.Path]::GetFileName($resolvedStage) -match '^\.profile-desk-stage-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
    $lock.Dispose()
}
