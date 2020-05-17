import { BASIS } from './basis-transcoder/build/basis_transcoder';

var BASIS_MODULE: any

function log(s: string) {
  console.log(s);
}

function logTime(desc: string, t: string) {
  log(t + 'ms ' + desc);
}

let formatTable = function(rows: any) {
  var colLengths = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    for (var j = 0; j < row.length; j++) {
      if (colLengths.length <= j) colLengths.push(0);
      if (colLengths[j] < row[j].length) colLengths[j] = row[j].length;
    }
  }

  function formatRow(row: any) {
    var parts = [];
    for (var i = 0; i < colLengths.length; i++) {
      var s = row.length > i ? row[i] : '';
      var padding = (new Array(1 + colLengths[i] - s.length)).join(' ');
      if (s && s[0] >= '0' && s[0] <= '9') {
        // Right-align numbers.
        parts.push(padding + s);
      } else {
        parts.push(s + padding);
      }
    }
    return parts.join(' | ');
  }

  var width = 0;
  for (var i = 0; i < colLengths.length; i++) {
    width += colLengths[i];
    // Add another 3 for the separator.
    if (i != 0) width += 3;
  }

  var lines = [];
  lines.push(formatRow(rows[0]));
  lines.push((new Array(width + 1)).join('-'));
  for (var i = 1; i < rows.length; i++) {
    lines.push(formatRow(rows[i]));
  }

  return lines.join('\n');
};

function loadArrayBuffer(uri: any, callback: any) {
  log('Loading ' + uri + '...');
  var xhr = new XMLHttpRequest();
  xhr.responseType = "arraybuffer";
  xhr.open('GET', uri, true);
  xhr.onreadystatechange = function(e) {
    if (xhr.readyState == 4 && xhr.status == 200) {
      callback(xhr.response);
    }
  }
  xhr.send(null);
}

// ASTC format, from:
// https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_astc/
const COMPRESSED_RGBA_ASTC_4x4_KHR = 0x93B0;

// DXT formats, from:
// http://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_s3tc/
const COMPRESSED_RGB_S3TC_DXT1_EXT  = 0x83F0;
const COMPRESSED_RGBA_S3TC_DXT1_EXT = 0x83F1;
const COMPRESSED_RGBA_S3TC_DXT3_EXT = 0x83F2;
const COMPRESSED_RGBA_S3TC_DXT5_EXT = 0x83F3;

// BC7 format, from:
// https://www.khronos.org/registry/webgl/extensions/EXT_texture_compression_bptc/
const COMPRESSED_RGBA_BPTC_UNORM = 0x8E8C;

// ETC format, from:
// https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_etc1/
const COMPRESSED_RGB_ETC1_WEBGL = 0x8D64;

// PVRTC format, from:
// https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_pvrtc/
const COMPRESSED_RGB_PVRTC_4BPPV1_IMG = 0x8C00;
const OMPRESSED_RGBA_PVRTC_4BPPV1_IMG = 0x8C02;

var BASIS_FORMAT = {
  cTFETC1: 0,
  cTFETC2: 1,
  cTFBC1: 2,
  cTFBC3: 3,
  cTFBC4: 4,
  cTFBC5: 5,
  cTFBC7: 6,
  cTFPVRTC1_4_RGB: 8,
  cTFPVRTC1_4_RGBA: 9,
  cTFASTC_4x4: 10,
  cTFATC_RGB: 11,
  cTFATC_RGBA_INTERPOLATED_ALPHA: 12,
  cTFRGBA32: 13,
  cTFRGB565: 14,
  cTFBGR565: 15,
  cTFRGBA4444: 16,
};

var BASIS_FORMAT_NAMES = {};
for (var name in BASIS_FORMAT) {
  BASIS_FORMAT_NAMES[BASIS_FORMAT[name]] = name;
}

var DXT_FORMAT_MAP = {};
DXT_FORMAT_MAP[BASIS_FORMAT.cTFBC1] = COMPRESSED_RGB_S3TC_DXT1_EXT;
DXT_FORMAT_MAP[BASIS_FORMAT.cTFBC3] = COMPRESSED_RGBA_S3TC_DXT5_EXT;
DXT_FORMAT_MAP[BASIS_FORMAT.cTFBC7] = COMPRESSED_RGBA_BPTC_UNORM; 

var astcSupported = false;
var etcSupported = false;
var dxtSupported = false;
var bc7Supported = false;
var pvrtcSupported = false;
var drawMode = 0;

var gpuTextureFormat: GPUTextureFormat;
var globalTextureData, globalWidth: number, globalHeight: number, globalBytesPerRow: number;
var tex, width, height, images, levels, have_alpha, alignedWidth, alignedHeight, format, displayWidth, displayHeight;

function dataLoaded(data: any)
{
  log('Done loading .basis file, decoded header:');

  const { BasisFile, initializeBasis } = BASIS_MODULE;
  initializeBasis();

  const startTime = performance.now();

  const basisFile = new BasisFile(new Uint8Array(data));

  width = basisFile.getImageWidth(0, 0);
  height = basisFile.getImageHeight(0, 0);
  images = basisFile.getNumImages();
  levels = basisFile.getNumLevels(0);
  var has_alpha = basisFile.getHasAlpha();

  if (!width || !height || !images || !levels) {
    console.warn('Invalid .basis file');
    basisFile.close();
    basisFile.delete();
    return;
  }

  // Note: If the file is UASTC, the preferred formats are ASTC/BC7.
  // If the file is ETC1S and doesn't have alpha, the preferred formats are ETC1 and BC1. For alpha, the preferred formats are ETC2, BC3 or BC7. 

  var formatString = 'UNKNOWN';
  if (astcSupported) {
    formatString = 'ASTC';
    format = BASIS_FORMAT.cTFASTC_4x4;
  } else if (bc7Supported) {
    formatString = 'BC7';
    format = BASIS_FORMAT.cTFBC7;
  } else if (dxtSupported) {
    if (has_alpha) {
      formatString = 'BC3';
      format = BASIS_FORMAT.cTFBC3;
    } else {
      formatString = 'BC1';
      format = BASIS_FORMAT.cTFBC1;
    }
  } else if (pvrtcSupported) {
    if (has_alpha) {
      formatString = 'PVRTC1_RGBA';
      format = BASIS_FORMAT.cTFPVRTC1_4_RGBA;
    } else {
      formatString = 'PVRTC1_RGB';
      format = BASIS_FORMAT.cTFPVRTC1_4_RGB;
    }
    
    if (((width & (width - 1)) != 0) || ((height & (height - 1)) != 0)) {
      log('ERROR: PVRTC1 requires square power of 2 textures');
    }

    if (width != height) {
      log('ERROR: PVRTC1 requires square power of 2 textures');    
    }
  } else if (etcSupported) {
    formatString = 'ETC1';
    format = BASIS_FORMAT.cTFETC1;
  } else {
    formatString = 'RGB565';
    format = BASIS_FORMAT.cTFRGB565;
    log('Decoding .basis data to 565');
  }

  log('format = ' + formatString);

  if (!basisFile.startTranscoding()) {
    log('startTranscoding failed');
    console.warn('startTranscoding failed');
    basisFile.close();
    basisFile.delete();
    return;
  }

  const dstSize = basisFile.getImageTranscodedSizeInBytes(0, 0, format);
  const dst = new Uint8Array(dstSize);
  
  log(dstSize);

  if (!basisFile.transcodeImage(dst, 0, 0, format, 0, 0)) {
    log('basisFile.transcodeImage failed');
    console.warn('transcodeImage failed');
    basisFile.close();
    basisFile.delete();

    return;
  }

  const elapsed = performance.now() - startTime;

  basisFile.close();
  basisFile.delete();

  log('width: ' + width);
  log('height: ' + height);
  log('images: ' + images);
  log('first image mipmap levels: ' + levels);
  log('has_alpha: ' + has_alpha);
  logTime('transcoding time', elapsed.toFixed(2));

  alignedWidth = (width + 3) & ~3;
  alignedHeight = (height + 3) & ~3;
  
  displayWidth = alignedWidth;
  displayHeight = alignedHeight;

  globalTextureData = null;
  globalWidth = width;
  globalHeight = height;

  if (format === BASIS_FORMAT.cTFASTC_4x4) {
    // tex = createCompressedTexture(dst, alignedWidth, alignedHeight, COMPRESSED_RGBA_ASTC_4x4_KHR);
    throw "Cannot handle cTFASTC_4x4";
  } else if ((format === BASIS_FORMAT.cTFBC3) || (format === BASIS_FORMAT.cTFBC1) || (format == BASIS_FORMAT.cTFBC7)) {
     // tex = createCompressedTexture(dst, alignedWidth, alignedHeight, DXT_FORMAT_MAP[format]);
     throw "Cannot handle cTFBC3";
  } else if (format === BASIS_FORMAT.cTFETC1) {
    // tex = createCompressedTexture(dst, alignedWidth, alignedHeight, COMPRESSED_RGB_ETC1_WEBGL);
    throw "Cannot handle cTFETC1";
  } else if (format === BASIS_FORMAT.cTFPVRTC1_4_RGB) {
    // tex = createCompressedTexture(dst, alignedWidth, alignedHeight, COMPRESSED_RGB_PVRTC_4BPPV1_IMG);
    throw "Cannot handle cTFPVRTC1_4_RGB";
  } else if (format === BASIS_FORMAT.cTFPVRTC1_4_RGBA) {
    // tex = createCompressedTexture(dst, alignedWidth, alignedHeight, COMPRESSED_RGBA_PVRTC_4BPPV1_IMG);
    throw "Cannot handle cTFPVRTC1_4_RGBA";
  } else { // cTFRGB565

    // Create RGBA32 texture.
    gpuTextureFormat = "rgba8unorm";
    globalBytesPerRow = Math.ceil(globalWidth * 4 / 256) * 256;
    globalTextureData = new Uint8Array(globalBytesPerRow * height);
    var imagePixelIndex = 0;
    var pix = 0;
    for (var y = 0; y < height; ++y) {
      for (var x = 0; x < width; ++x, ++pix) {
        const i = x * 4 + y * globalBytesPerRow;
        const rgb565 = dst[2 * pix + 0] | (dst[2 * pix + 1] << 8);
        globalTextureData[i + 0] = 255 * ((rgb565        >> 11) / 32); // Red   // dst[imagePixelIndex + 0];
        globalTextureData[i + 1] = 255 * ((rgb565 & 2016 >>  5) / 64); // Green // dst[imagePixelIndex + 1];
        globalTextureData[i + 2] = 255 * ((rgb565 &   31      ) / 32); // Blue  // dst[imagePixelIndex + 2];
        globalTextureData[i + 3] = 255; // dst[imagePixelIndex + 3];   // Alpha
        imagePixelIndex += 4;
      }
    }

    // Inspect a few bytes/pixels...
    // for (var x = 0; x < globalBytesPerRow / 100; ++x) {
    //   const y = 53; // Choose a random line
    //   const i = x * 4 + y * globalBytesPerRow;
    //   log("["+(i+0)+"] R = " + globalTextureData[i + 0]);
    //   log("["+(i+1)+"] G = " + globalTextureData[i + 1]);
    //   log("["+(i+2)+"] B = " + globalTextureData[i + 2]);
    //   log("["+(i+3)+"] A = " + globalTextureData[i + 3]);
    // }

    // // Create 565 texture. 
    // gpuTextureFormat = "rg8unorm";
    // globalBytesPerRow = Math.ceil(globalWidth * 2 / 16) * 16;
    // globalTextureData = new Uint16Array(width * height);
    // // Convert the array of bytes to an array of uint16's.
    // var pix = 0;
    // for (var y = 0; y < height; y++)
    //   for (var x = 0; x < width; x++, pix++) {
    //     // globalTextureData[pix] = dst[2 * pix + 0] | (dst[2 * pix + 1] << 8);
    //   }
    // // // tex = createRgb565Texture(globalTextureData, width, height);
   }

  // redraw();
}

export async function createTextureFromBasis(device: GPUDevice, src: string, usage: GPUTextureUsageFlags) {
  const basis_promise = new Promise(function (resolve, reject) {
    BASIS({onRuntimeInitialized : () => {
      console.log("BASIS_MODULE is being initialised...");
    }
  }).then( function (module : NodeModule) {
      BASIS_MODULE = module;
      console.log("Ok: BASIS_MODULE is working;");
      resolve();
    });
  });

  await basis_promise;


  const texture_promise = new Promise(function (resolve, reject) {
    console.log("Going to load the texture file: " + src);
    loadArrayBuffer(src, function (data: any) {
      dataLoaded(data);
      resolve();
    });
  });

  await texture_promise;


  if (null == globalTextureData) {
    log("Failed to load and transcode the texture.");
  } else {
    log("Going to call device.createTexture(" + globalWidth + "," + globalHeight + ");");
    log("globalTextureData.byteLength = " + globalTextureData.byteLength);
    log("gobalBytesPerRow = " + globalBytesPerRow);

    const bytesPerRow = globalBytesPerRow;

    const texture = device.createTexture({
      size: {
        width: globalWidth,
        height: globalHeight,
        depth: 1,
      },
      format: gpuTextureFormat,
      usage: GPUTextureUsage.COPY_DST | usage,
    });

    const [textureDataBuffer, mapping] = device.createBufferMapped({
      size: globalTextureData.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    new Uint8Array(mapping).set(globalTextureData);
    textureDataBuffer.unmap();

    const commandEncoder = device.createCommandEncoder({});
    commandEncoder.copyBufferToTexture({
      buffer: textureDataBuffer,
      bytesPerRow,
    }, {
      texture: texture,
    }, {
      width: globalWidth,
      height: globalHeight,
      depth: 1,
    });

    device.defaultQueue.submit([commandEncoder.finish()]);
    textureDataBuffer.destroy();

    return texture;
  }
}
