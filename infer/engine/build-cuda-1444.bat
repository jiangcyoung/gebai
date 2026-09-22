@echo off
REM build-cuda-1444.bat ? ? VS18 ?? MSVC 14.44 ????VS2022 era??? llama.cpp CUDA ?
REM ???CUDA 12.9 ? nvcc ??? MSVC <= 2022?_MSC_VER <= 1949??
REM       VS18 ???? 14.44.35207 ? 14.51.36231?? -vcvars_ver=14.44 ???????
setlocal
set VCVARS="C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set SRC=C:\Users\Administrator\code\gebai\infer\engine\llama.cpp-b11100
set BUILD=%SRC%\build-cuda
set NINJA=C:\Users\Administrator\AppData\Local\Programs\Python\Python312\Scripts
set CUDA=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9

call %VCVARS% -vcvars_ver=14.44 >nul 2>&1
if errorlevel 1 ( echo VCVARS_FAILED & exit /b 1 )

set PATH=%NINJA%;%CUDA%\bin;%PATH%

echo === ????? ===
where cl
where nvcc
nvcc --version | findstr release

cd /d "%SRC%" || exit /b 1

echo.
echo === CMake ???CUDA / sm_89 / Release?===
cmake -B "%BUILD%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DGGML_CUDA=ON ^
  -DCMAKE_CUDA_ARCHITECTURES=89 ^
  -DCMAKE_CUDA_COMPILER="%CUDA%\bin\nvcc.exe" ^
  -DLLAMA_CURL=OFF ^
  -DLLAMA_BUILD_TESTS=OFF ^
  -DLLAMA_BUILD_EXAMPLES=ON ^
  -DLLAMA_BUILD_SERVER=ON
if errorlevel 1 ( echo CONFIGURE_FAILED & exit /b 1 )

echo.
echo === ?? ===
cmake --build "%BUILD%" -j 16
if errorlevel 1 ( echo BUILD_FAILED & exit /b 1 )

echo.
echo === ?? ===
dir "%BUILD%\bin\llama-bench.exe" "%BUILD%\bin\llama-server.exe" 2>nul
echo BUILD_DONE
