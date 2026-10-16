setTimeout(function boomer() { const e = new RangeError('named'); e.code = 'X'; throw e; }, 1);
